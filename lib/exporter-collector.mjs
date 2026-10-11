import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { hasSensitiveValue, isPlainObject, parseConfigJson, sanitizeConfig, sanitizeConfigValue } from "./config.mjs";
import { portablePathFor, validatePortablePath } from "./paths.mjs";
import { normalizePackageSpec } from "./resources.mjs";
import { ERROR_CODES, failure, success } from "./result.mjs";

const CONFIG_FILES = ["settings.json", "keybindings.json", "mcp.json", "models.json"];
const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD", "SYSTEM.md", "APPEND_SYSTEM.md"];
const RESOURCE_DIRECTORIES = [
  { name: "extensions", kind: "extension" },
  { name: "skills", kind: "skill" },
  { name: "prompts", kind: "prompt" },
  { name: "themes", kind: "theme" },
];
const RESOURCE_SETTING_KINDS = {
  extensions: "extension",
  skills: "skill",
  prompts: "prompt",
  themes: "theme",
};

export async function collectSnapshotSources(options) {
  const context = createContext(options);
  const sourceCheck = await validateSourceDirectories(context);
  if (!sourceCheck.ok) return sourceCheck;
  const destinationCheck = await validateSnapshotDestination(context);
  if (!destinationCheck.ok) return destinationCheck;

  for (const fileName of CONFIG_FILES) {
    const collected = await collectConfigurationFile(fileName, context);
    if (!collected.ok) return collected;
  }
  for (const fileName of INSTRUCTION_FILES) {
    const collected = await collectInstructionFile(fileName, context);
    if (!collected.ok) return collected;
  }
  for (const resource of RESOURCE_DIRECTORIES) {
    const collected = await collectRoot(path.join(context.agentDir, resource.name), `agent/${resource.name}`, resource.kind, context, false);
    if (!collected.ok) return collected;
  }
  const userSkills = await collectRoot(
    path.join(context.home, ".agents", "skills"),
    "home/.agents/skills",
    "skill",
    context,
    false,
  );
  if (!userSkills.ok) return userSkills;

  return success({
    files: [...context.files.values()],
    packages: context.packages,
    resources: [...context.resources.values()],
    report: context.report,
  });
}

function createContext(options) {
  return {
    ...options,
    files: new Map(),
    packages: [],
    resources: new Map(),
    visitedRoots: new Set(),
    packageRoots: [],
    report: { skippedSensitivePaths: 0, skippedSymlinks: 0, skippedOtherEntries: 0, omittedConfigFields: [] },
  };
}

async function validateSourceDirectories(context) {
  const home = await inspectDirectory(context.home);
  if (!home.ok) return home;
  return inspectDirectory(context.agentDir);
}

async function inspectDirectory(directory) {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    return failure(error?.code === "ENOENT" ? ERROR_CODES.MISSING : ERROR_CODES.INVALID_PATH);
  }
  if (stat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
  return stat.isDirectory() ? success(undefined) : failure(ERROR_CODES.INVALID_TYPE);
}

async function validateSnapshotDestination(context) {
  const protectedSources = [context.agentDir, path.join(context.home, ".agents", "skills")];
  if (protectedSources.some((source) => isWithin(source, context.snapshotDir) || isWithin(context.snapshotDir, source))) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  if (context.snapshotDir === context.packageRoot || isWithin(context.snapshotDir, context.packageRoot)) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  if (context.snapshotDir === context.home || isWithin(context.snapshotDir, context.home)) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  try {
    const stat = await lstat(context.snapshotDir);
    if (stat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
    if (!stat.isDirectory()) return failure(ERROR_CODES.INVALID_TYPE);
    if (!context.overwrite) return failure(ERROR_CODES.CONFLICT);
  } catch (error) {
    if (error?.code !== "ENOENT") return failure(ERROR_CODES.INVALID_PATH);
  }
  return success(undefined);
}

async function collectConfigurationFile(fileName, context) {
  const source = await readOptionalFile(path.join(context.agentDir, fileName));
  if (!source.ok) return source.error.code === ERROR_CODES.MISSING ? success(undefined) : source;
  const parsed = parseConfigJson(source.value.toString("utf8"));
  if (!parsed.ok) return parsed;
  const sanitized = sanitizeConfig(parsed.value);
  if (!sanitized.ok) return sanitized;
  const config = sanitized.value.value;
  context.report.omittedConfigFields.push(...sanitized.value.omittedFields.map((field) => `agent/${fileName}:${field}`));

  if (fileName === "settings.json") {
    const prepared = await prepareSettings(config, context);
    if (!prepared.ok) return prepared;
  }
  if (containsAbsolutePath(config)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  return addFile(`agent/${fileName}`, serializeJson(config), context);
}

async function collectInstructionFile(fileName, context) {
  const source = await readOptionalFile(path.join(context.agentDir, fileName));
  if (!source.ok) return source.error.code === ERROR_CODES.MISSING ? success(undefined) : source;
  if (hasSensitiveValue(source.value.toString("utf8"))) return failure(ERROR_CODES.SENSITIVE_CONTENT);
  return addFile(`agent/${fileName}`, source.value, context);
}

async function readOptionalFile(sourcePath) {
  let stat;
  try {
    stat = await lstat(sourcePath);
  } catch (error) {
    return failure(error?.code === "ENOENT" ? ERROR_CODES.MISSING : ERROR_CODES.INVALID_PATH);
  }
  if (stat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
  if (!stat.isFile()) return failure(ERROR_CODES.INVALID_TYPE);
  try {
    return success(await readFile(sourcePath));
  } catch {
    return failure(ERROR_CODES.INVALID_PATH);
  }
}

async function prepareSettings(settings, context) {
  if (Object.hasOwn(settings, "packages")) {
    if (!Array.isArray(settings.packages)) return failure(ERROR_CODES.INVALID_TYPE);
    for (const declaration of settings.packages) {
      const normalized = normalizePackageSpec(declaration, {
        baseDir: context.agentDir,
        agentDir: context.agentDir,
        home: context.home,
      });
      if (!normalized.ok) return normalized;
      context.packages.push(normalized.value);
      if (normalized.value.kind === "local") {
        const absolutePath = fromPortablePath(normalized.value.path, context);
        if (!absolutePath.ok || isBroadPackageRoot(normalized.value.path)) {
          return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
        }
        context.packageRoots.push({ absolutePath: absolutePath.value, portablePath: normalized.value.path });
      }
    }
    delete settings.packages;
  }

  for (const [settingName, kind] of Object.entries(RESOURCE_SETTING_KINDS)) {
    if (!Object.hasOwn(settings, settingName)) continue;
    if (!Array.isArray(settings[settingName])) return failure(ERROR_CODES.INVALID_TYPE);
    const declarations = [];
    for (const declaration of settings[settingName]) {
      if (typeof declaration !== "string") return failure(ERROR_CODES.INVALID_TYPE);
      const normalized = await normalizeResourceDeclaration(declaration, kind, context);
      if (!normalized.ok) return normalized;
      declarations.push(normalized.value.declaration);
      if (normalized.value.root) {
        const collected = await collectRoot(
          normalized.value.root.absolutePath,
          normalized.value.root.portablePath,
          kind,
          context,
          true,
        );
        if (!collected.ok) return collected;
      }
    }
    settings[settingName] = declarations;
  }
  return collectLocalPackages(context);
}

async function normalizeResourceDeclaration(declaration, kind, context) {
  let modifier = "";
  let pattern = declaration;
  if (/^[!+-]/.test(pattern)) {
    modifier = pattern[0];
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("builtin:")) return success({ declaration, root: null });
  if (pattern.length === 0) return failure(ERROR_CODES.INVALID_PATH);

  const normalizedPattern = pattern.replace(/\\/g, "/");
  const globIndex = normalizedPattern.search(/[?*{\[]/);
  const hasGlob = globIndex >= 0;
  let sourcePrefix;
  let suffix = "";
  if (hasGlob) {
    const prefixText = normalizedPattern.slice(0, globIndex);
    const slashIndex = prefixText.lastIndexOf("/");
    sourcePrefix = slashIndex >= 0 ? prefixText.slice(0, slashIndex) : "";
    suffix = normalizedPattern.slice(sourcePrefix.length).replace(/^\/+/, "");
    if (sourcePrefix.length === 0) sourcePrefix = ".";
    if (!isSafeGlobSuffix(suffix)) return failure(ERROR_CODES.INVALID_PATH);
  } else {
    sourcePrefix = normalizedPattern;
  }

  const absolutePath = resolveSettingPath(sourcePrefix, context);
  if (!absolutePath.ok) return absolutePath;
  const portable = portablePathFor(absolutePath.value, { agentDir: context.agentDir, home: context.home });
  if (!portable.ok) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  if (["agent", "home", "home/.pi", "home/.agents"].includes(portable.value)) {
    return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  }

  const portableBase = settingPathFromPortable(portable.value);
  if (!portableBase.ok) return portableBase;
  const normalizedDeclaration = `${modifier}${portableBase.value}${suffix ? `/${suffix}` : ""}`;
  const includeResource = modifier !== "!" && modifier !== "-";
  return success({
    declaration: normalizedDeclaration,
    root: includeResource ? { absolutePath: absolutePath.value, portablePath: portable.value } : null,
  });
}

function isSafeGlobSuffix(suffix) {
  if (!suffix || suffix.includes("\\") || /[\u0000-\u001f\u007f<>:"|]/.test(suffix)) return false;
  return !suffix.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

function resolveSettingPath(source, context) {
  if (source === ".") return success(context.agentDir);
  if (source === "~" || source.startsWith("~/")) return success(path.resolve(context.home, source === "~" ? "." : source.slice(2)));
  if (source.startsWith("~\\")) return success(path.resolve(context.home, source.slice(2)));
  if (path.isAbsolute(source)) return success(path.resolve(source));
  if (path.win32.isAbsolute(source)) return success(path.win32.resolve(source));
  return success(path.resolve(context.agentDir, source));
}

function settingPathFromPortable(portablePath) {
  const [rootName, ...segments] = portablePath.split("/");
  const relative = segments.join("/");
  if (rootName === "agent" && relative) return success(relative);
  if (rootName === "home" && relative) return success(`~/${relative}`);
  return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
}

async function collectLocalPackages(context) {
  for (const root of context.packageRoots) {
    const collected = await collectRoot(root.absolutePath, root.portablePath, null, context, true);
    if (!collected.ok) return collected;
  }
  return success(undefined);
}

function fromPortablePath(portablePath, context) {
  const [rootName, ...segments] = portablePath.split("/");
  const root = rootName === "agent" ? context.agentDir : rootName === "home" ? context.home : null;
  if (!root) return failure(ERROR_CODES.INVALID_PATH);
  return success(path.join(root, ...segments));
}

async function hasSymlinkInSourcePath(sourcePath, portablePath, context) {
  const rootName = portablePath.split("/", 1)[0];
  const root = rootName === "agent" ? context.agentDir : rootName === "home" ? context.home : null;
  if (!root || !isWithin(root, sourcePath)) return failure(ERROR_CODES.INVALID_PATH);
  const relative = path.relative(root, sourcePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return success(false);
      return failure(ERROR_CODES.INVALID_PATH);
    }
    if (stat.isSymbolicLink()) return success(true);
    if (index < segments.length - 1 && !stat.isDirectory()) return failure(ERROR_CODES.INVALID_TYPE);
  }
  return success(false);
}

function isBroadPackageRoot(portablePath) {
  return ["agent", "home", "home/.pi", "home/.pi/agent", "home/.agents"].includes(portablePath);
}

async function collectRoot(sourcePath, portableRoot, kind, context, explicit) {
  const pathResult = validatePortablePath(portableRoot);
  if (!pathResult.ok) return pathResult;
  const symlinkCheck = await hasSymlinkInSourcePath(sourcePath, portableRoot, context);
  if (!symlinkCheck.ok) return symlinkCheck;
  if (symlinkCheck.value) {
    context.report.skippedSymlinks += 1;
    return explicit ? failure(ERROR_CODES.INVALID_PATH) : success(undefined);
  }
  const identity = normalizeAbsolutePath(sourcePath);
  if (context.visitedRoots.has(identity)) {
    if (kind && hasFilesAtPath(context.files, portableRoot)) {
      context.resources.set(`${kind}:${portableRoot.toLowerCase()}`, { kind, path: portableRoot });
    }
    return success(undefined);
  }
  context.visitedRoots.add(identity);

  let stat;
  try {
    stat = await lstat(sourcePath);
  } catch (error) {
    if (error?.code === "ENOENT" && !explicit) return success(undefined);
    return failure(error?.code === "ENOENT" ? ERROR_CODES.MISSING : ERROR_CODES.INVALID_PATH);
  }
  if (stat.isSymbolicLink()) {
    context.report.skippedSymlinks += 1;
    return explicit ? failure(ERROR_CODES.INVALID_PATH) : success(undefined);
  }
  if (!stat.isDirectory() && !stat.isFile()) return failure(ERROR_CODES.INVALID_TYPE);

  const filesBefore = context.files.size;
  const result = stat.isDirectory()
    ? await walkDirectory(sourcePath, portableRoot, context)
    : await collectRegularFile(sourcePath, portableRoot, context);
  if (!result.ok) return result;
  if (kind && context.files.size > filesBefore) {
    context.resources.set(`${kind}:${portableRoot.toLowerCase()}`, { kind, path: portableRoot });
  }
  return success(undefined);
}

async function walkDirectory(sourceRoot, portableRoot, context) {
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    if (isWithin(context.snapshotDir, sourcePath)) continue;
    const relativePath = `${portableRoot}/${entry.name}`;
    const pathResult = validatePortablePath(relativePath);
    if (!pathResult.ok) {
      if (pathResult.error.code === ERROR_CODES.SENSITIVE_CONTENT) {
        context.report.skippedSensitivePaths += 1;
        continue;
      }
      return pathResult;
    }
    if (entry.isSymbolicLink()) {
      context.report.skippedSymlinks += 1;
      continue;
    }
    if (entry.isDirectory()) {
      const nested = await walkDirectory(sourcePath, pathResult.value, context);
      if (!nested.ok) return nested;
    } else if (entry.isFile()) {
      const collected = await collectRegularFile(sourcePath, pathResult.value, context);
      if (!collected.ok) return collected;
    } else {
      context.report.skippedOtherEntries += 1;
    }
  }
  return success(undefined);
}

async function collectRegularFile(sourcePath, portablePath, context) {
  const pathResult = validatePortablePath(portablePath);
  if (!pathResult.ok) {
    if (pathResult.error.code === ERROR_CODES.SENSITIVE_CONTENT) {
      context.report.skippedSensitivePaths += 1;
      return success(undefined);
    }
    return pathResult;
  }
  if (isWithin(context.snapshotDir, sourcePath)) return success(undefined);

  let content;
  try {
    content = await readFile(sourcePath);
  } catch {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  const text = content.toString("utf8");
  if (hasSensitiveValue(text)) return failure(ERROR_CODES.SENSITIVE_CONTENT);
  if (path.posix.extname(portablePath).toLowerCase() === ".json") {
    const json = tryParseJson(text);
    if (json.ok) {
      const sanitized = sanitizeConfigValue(json.value);
      if (!sanitized.ok) return sanitized;
      if (sanitized.value.omittedFields.length > 0) {
        context.report.omittedConfigFields.push(...sanitized.value.omittedFields.map((field) => `${portablePath}:${field}`));
        content = serializeJson(sanitized.value.value);
      }
    }
  }
  return addFile(pathResult.value, content, context);
}

function tryParseJson(input) {
  try {
    return success(JSON.parse(input));
  } catch {
    return failure(ERROR_CODES.INVALID_FORMAT);
  }
}

function addFile(portablePath, content, context) {
  const validated = validatePortablePath(portablePath);
  if (!validated.ok) return validated;
  const identity = validated.value.toLowerCase();
  const existing = context.files.get(identity);
  if (existing) {
    return existing.content.equals(content) ? success(undefined) : failure(ERROR_CODES.INVALID_FORMAT);
  }
  context.files.set(identity, { path: validated.value, content: Buffer.from(content) });
  return success(undefined);
}

function serializeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeAbsolutePath(value) {
  return path.resolve(value).toLowerCase();
}

function containsAbsolutePath(value) {
  if (typeof value === "string") {
    if (/^(?:https?|wss?):\/\//i.test(value) || /^(?:npm:|git:)/i.test(value)) return false;
    return path.isAbsolute(value) || path.win32.isAbsolute(value);
  }
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (isPlainObject(value)) return Object.values(value).some(containsAbsolutePath);
  return false;
}

function hasFilesAtPath(files, portableRoot) {
  const root = portableRoot.toLowerCase();
  return [...files.values()].some(({ path: filePath }) => {
    const normalized = filePath.toLowerCase();
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

