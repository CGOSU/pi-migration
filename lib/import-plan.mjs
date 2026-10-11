import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { hasSensitiveValue, isPlainObject, parseConfigJson, sanitizeConfig, sanitizeConfigValue } from "./config.mjs";
import { validatePortablePath } from "./paths.mjs";
import { ERROR_CODES, failure, success } from "./result.mjs";

const CONFIG_FILES = new Set(["settings.json", "keybindings.json", "mcp.json", "models.json"]);

export async function createImportPlan(manifest, verifiedFiles, options) {
  const rootsResult = await validateTargetRoots(options);
  if (!rootsResult.ok) return rootsResult;
  const snapshotBoundary = validateSnapshotBoundary(options);
  if (!snapshotBoundary.ok) return snapshotBoundary;

  const packageDeclarations = [];
  const remotePackages = [];
  const localPackages = [];
  for (let index = 0; index < manifest.packages.length; index += 1) {
    const packageSpec = manifest.packages[index];
    const declaration = convertPackageDeclaration(packageSpec, options);
    if (!declaration.ok) return declaration;
    packageDeclarations.push(declaration.value);
    if (packageSpec.kind === "remote") {
      remotePackages.push({ packageNumber: index + 1, source: packageSpec.source });
    } else {
      localPackages.push({ packageNumber: index + 1, packageSpec });
    }
  }

  const verifiedByPath = new Map();
  for (const file of verifiedFiles) {
    const pathCheck = validateImportPortablePath(file.path);
    if (!pathCheck.ok) return pathCheck;
    verifiedByPath.set(file.path.toLowerCase(), file);
  }
  const omittedConfigurationFields = verifiedFiles.flatMap((file) => file.omittedFields.map((field) => `${file.path}:${field}`));
  const files = verifiedFiles.map((file) => ({
    portablePath: file.path,
    ...resolvePortableTarget(file.path, options),
    content: file.content,
    status: "pending",
    existingContent: null,
  }));

  let settingsFile = files.find((file) => file.portablePath.toLowerCase() === "agent/settings.json");
  if (settingsFile || manifest.packages.length > 0) {
    let settings;
    if (settingsFile) {
      const parsed = parseConfigJson(settingsFile.content.toString("utf8"));
      if (!parsed.ok) return parsed;
      settings = parsed.value;
    } else {
      settings = {};
      const target = resolvePortableTarget("agent/settings.json", options);
      files.push({
        portablePath: "agent/settings.json",
        ...target,
        content: Buffer.alloc(0),
        status: "pending",
        existingContent: null,
      });
      settingsFile = files.at(-1);
    }
    delete settings.packages;
    if (manifest.packages.length > 0) settings.packages = packageDeclarations;
    settingsFile.content = serializeJson(settings);
  }

  for (const file of files) {
    if (isWithin(options.snapshotDir, file.targetPath) || isWithin(file.targetPath, options.snapshotDir)) {
      return failure(ERROR_CODES.INVALID_PATH);
    }
  }
  const planCollision = validateFilePlanCollisions(files);
  if (!planCollision.ok) return planCollision;

  const directories = collectRequiredDirectories(files, manifest, options, verifiedByPath);
  if (!directories.ok) return directories;
  const directoryStatus = await inspectPlannedDirectories(directories.value, options);
  if (!directoryStatus.ok) return directoryStatus;

  const fileStatus = await inspectPlannedFiles(files, options.overwrite);
  if (!fileStatus.ok) return fileStatus;

  const localDependencies = findLocalPackageDependencies(localPackages, verifiedByPath);
  if (!localDependencies.ok) return localDependencies;

  return success({
    files,
    directories: directories.value,
    packages: manifest.packages,
    remotePackages: deduplicateRemotePackages(remotePackages),
    localPackages,
    localDependencies: localDependencies.value,
    omittedConfigurationFields,
    settingsFile,
  });
}

function validateImportPortablePath(input) {
  const validated = validatePortablePath(input);
  if (!validated.ok) return validated;
  const segments = validated.value.split("/");
  if (segments.length < 2 || (segments[0] !== "agent" && segments[0] !== "home")) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  if (segments[0] === "home" && ((segments[1] === ".pi" && (segments[2] === undefined || segments[2] === "agent"))
    || (segments[1] === ".agents" && segments[2] === undefined))) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  return success(validated.value);
}

function resolvePortableTarget(portablePath, options) {
  const segments = portablePath.split("/");
  const rootPath = segments[0] === "agent" ? options.agentDir : options.home;
  return {
    rootPath,
    targetPath: path.resolve(rootPath, ...segments.slice(1)),
  };
}

function convertPackageDeclaration(packageSpec, options) {
  let source;
  if (packageSpec.kind === "remote") {
    source = packageSpec.source;
  } else {
    const pathCheck = validateImportPortablePath(packageSpec.path);
    if (!pathCheck.ok || isBroadLocalPackageRoot(packageSpec.path)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
    const target = resolvePortableTarget(packageSpec.path, options).targetPath;
    const relative = path.relative(options.agentDir, target);
    if (relative.length === 0 || path.isAbsolute(relative)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
    const normalized = relative.replace(/\\/g, "/");
    source = normalized.startsWith(".") ? normalized : `./${normalized}`;
  }

  const declaration = { source };
  if (packageSpec.filters) {
    for (const [name, filters] of Object.entries(packageSpec.filters)) declaration[name] = [...filters];
  }
  if (packageSpec.autoload !== undefined) declaration.autoload = packageSpec.autoload;
  return success(declaration);
}

function isBroadLocalPackageRoot(portablePath) {
  return ["agent", "home", "home/.pi", "home/.pi/agent", "home/.agents"].includes(portablePath);
}

function validateFilePlanCollisions(files) {
  const seen = new Map();
  for (const file of files) {
    const identity = path.resolve(file.targetPath).toLowerCase();
    if (seen.has(identity)) return failure(ERROR_CODES.INVALID_FORMAT);
    seen.set(identity, file);
  }
  const entries = [...seen.entries()];
  for (let index = 0; index < entries.length; index += 1) {
    const [, parentFile] = entries[index];
    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      const [, candidateFile] = entries[otherIndex];
      if (isWithin(parentFile.targetPath, candidateFile.targetPath)
        || isWithin(candidateFile.targetPath, parentFile.targetPath)) {
        return failure(ERROR_CODES.INVALID_FORMAT);
      }
    }
  }
  return success(undefined);
}

function collectRequiredDirectories(files, manifest, options, verifiedByPath) {
  const directories = new Map();
  for (const file of files) {
    let current = path.dirname(file.targetPath);
    while (isWithin(file.rootPath, current) && current !== file.rootPath) {
      addDirectory(current, file.rootPath, file.portablePath, directories);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const resource of manifest.resources) {
    const pathCheck = validateImportPortablePath(resource.path);
    if (!pathCheck.ok) return pathCheck;
    const target = resolvePortableTarget(resource.path, options);
    if (!verifiedByPath.has(resource.path.toLowerCase())) {
      addDirectory(target.targetPath, target.rootPath, resource.path, directories);
    }
  }
  for (const packageSpec of manifest.packages.filter((entry) => entry.kind === "local")) {
    const pathCheck = validateImportPortablePath(packageSpec.path);
    if (!pathCheck.ok || isBroadLocalPackageRoot(packageSpec.path)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
    const target = resolvePortableTarget(packageSpec.path, options);
    if (!verifiedByPath.has(packageSpec.path.toLowerCase())) {
      addDirectory(target.targetPath, target.rootPath, packageSpec.path, directories);
    }
  }
  return success([...directories.values()].sort((left, right) => left.targetPath.length - right.targetPath.length));
}

function addDirectory(targetPath, rootPath, portablePath, directories) {
  const identity = path.resolve(targetPath).toLowerCase();
  if (!directories.has(identity)) directories.set(identity, { targetPath, rootPath, portablePath });
}

async function inspectPlannedDirectories(directories, options) {
  for (const directory of directories) {
    const inspected = await inspectTargetPath(directory.rootPath, directory.targetPath);
    if (!inspected.ok) return inspected;
    if (inspected.value.exists && !inspected.value.stat.isDirectory()) return failure(ERROR_CODES.INVALID_TYPE);
  }
  if (options.agentDir !== options.home) {
    const agent = await inspectTargetRoot(options.agentDir, true);
    if (!agent.ok) return agent;
  }
  return success(undefined);
}

async function inspectPlannedFiles(files, overwrite) {
  for (const file of files) {
    const inspected = await inspectTargetPath(file.rootPath, file.targetPath);
    if (!inspected.ok) return inspected;
    if (!inspected.value.exists) {
      file.status = "new";
      continue;
    }
    if (!inspected.value.stat.isFile()) return failure(ERROR_CODES.INVALID_TYPE);
    let content;
    try {
      content = await readFile(file.targetPath);
    } catch {
      return failure(ERROR_CODES.INVALID_PATH);
    }
    const safeExisting = validateExistingContent(file.portablePath, content);
    if (!safeExisting.ok) return safeExisting;
    file.existingContent = content;
    if (content.equals(file.content)) {
      file.status = "unchanged";
      continue;
    }
    if (!overwrite) return failure(ERROR_CODES.CONFLICT);
    file.status = "replace";
  }
  return success(undefined);
}

export function validateExistingContent(portablePath, content) {
  const text = content.toString("utf8");
  if (hasSensitiveValue(text)) return failure(ERROR_CODES.SENSITIVE_CONTENT);
  const fileName = path.posix.basename(portablePath);
  const isPiConfiguration = portablePath.startsWith("agent/")
    && portablePath.split("/").length === 2
    && CONFIG_FILES.has(fileName);
  if (isPiConfiguration) {
    const parsed = parseConfigJson(text);
    if (!parsed.ok) return parsed;
    return sanitizeConfig(parsed.value).ok ? success(undefined) : failure(ERROR_CODES.SENSITIVE_CONTENT);
  }
  if (path.posix.extname(portablePath).toLowerCase() === ".json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return failure(ERROR_CODES.INVALID_FORMAT);
    }
    const sanitized = sanitizeConfigValue(parsed);
    if (!sanitized.ok) return sanitized;
  }
  return success(undefined);
}

async function inspectTargetRoot(rootPath, allowMissing) {
  let stat;
  try {
    stat = await lstat(rootPath);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return success({ exists: false });
    return failure(error?.code === "ENOENT" ? ERROR_CODES.MISSING : ERROR_CODES.INVALID_PATH);
  }
  if (stat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
  return stat.isDirectory() ? success({ exists: true, stat }) : failure(ERROR_CODES.INVALID_TYPE);
}

async function inspectTargetPath(rootPath, targetPath) {
  const rootResult = await inspectTargetRoot(rootPath, rootPath !== targetPath);
  if (!rootResult.ok) return rootResult;
  if (!rootResult.value.exists) return success({ exists: false });
  const relative = path.relative(rootPath, targetPath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  const segments = relative.split(path.sep);
  let current = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return success({ exists: false });
      return failure(ERROR_CODES.INVALID_PATH);
    }
    if (stat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
    if (index < segments.length - 1 && !stat.isDirectory()) return failure(ERROR_CODES.INVALID_TYPE);
    if (index === segments.length - 1) return success({ exists: true, stat });
  }
  return failure(ERROR_CODES.INVALID_PATH);
}

async function validateTargetRoots(options) {
  if (path.parse(options.home).root === options.home) return failure(ERROR_CODES.INVALID_PATH);
  const homePath = validateRootPath("home", options.home);
  if (!homePath.ok) return homePath;
  const agentPath = validateRootPath("agent", options.agentDir, options.home);
  if (!agentPath.ok) return agentPath;
  const home = await inspectTargetRoot(options.home, false);
  if (!home.ok) return home;
  if (options.agentDir === options.home || isWithin(options.agentDir, options.home)) return failure(ERROR_CODES.INVALID_PATH);
  const agent = await inspectTargetRoot(options.agentDir, true);
  if (!agent.ok) return agent;
  const agentBoundary = await inspectNoSymlinkComponents(options.agentDir, options.home);
  return agentBoundary.ok ? success(undefined) : agentBoundary;
}

async function inspectNoSymlinkComponents(targetPath, trustedRoot) {
  const base = isWithin(trustedRoot, targetPath) ? trustedRoot : path.parse(targetPath).root;
  const relative = path.relative(base, targetPath);
  let current = base;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return success(undefined);
      return failure(ERROR_CODES.INVALID_PATH);
    }
    if (stat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
    if (index < segments.length - 1 && !stat.isDirectory()) return failure(ERROR_CODES.INVALID_TYPE);
  }
  return success(undefined);
}

function validateRootPath(rootName, rootPath, trustedRoot) {
  const relative = trustedRoot && isWithin(trustedRoot, rootPath)
    ? path.relative(trustedRoot, rootPath)
    : path.basename(rootPath);
  const portable = `${rootName}/${relative.split(path.sep).filter(Boolean).join("/")}`;
  return validatePortablePath(portable);
}

function validateSnapshotBoundary(options) {
  const skillsRoot = path.join(options.home, ".agents", "skills");
  const backupRoot = path.join(options.home, ".pi-migration-backups");
  if (isWithin(options.agentDir, options.snapshotDir)
    || isWithin(options.snapshotDir, options.agentDir)
    || isWithin(skillsRoot, options.snapshotDir)
    || isWithin(options.snapshotDir, skillsRoot)
    || isWithin(backupRoot, options.snapshotDir)
    || isWithin(options.snapshotDir, backupRoot)) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  return success(undefined);
}

function findLocalPackageDependencies(localPackages, verifiedByPath) {
  const missing = [];
  for (const { packageNumber, packageSpec } of localPackages) {
    const packagePath = packageSpec.path.replace(/\/$/, "");
    const packageKey = packagePath.toLowerCase();
    if (verifiedByPath.has(packageKey)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
    if (![...verifiedByPath.keys()].some((filePath) => filePath.startsWith(`${packageKey}/`))) {
      return failure(ERROR_CODES.MISSING);
    }
    const packageJsonPath = `${packagePath}/package.json`.toLowerCase();
    const packageJson = verifiedByPath.get(packageJsonPath);
    if (!packageJson) continue;
    let parsed;
    try {
      parsed = JSON.parse(packageJson.content.toString("utf8"));
    } catch {
      return failure(ERROR_CODES.INVALID_FORMAT);
    }
    if (!isPlainObject(parsed)) return failure(ERROR_CODES.INVALID_TYPE);
    const dependencies = parsed.dependencies ?? {};
    if (!isPlainObject(dependencies)) return failure(ERROR_CODES.INVALID_TYPE);
    const names = Object.keys(dependencies).sort();
    if (names.length > 0) missing.push({ packageNumber, names });
  }
  return success(missing);
}

function deduplicateRemotePackages(packages) {
  const seen = new Set();
  return packages.filter((item) => {
    const identity = item.source;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function serializeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
