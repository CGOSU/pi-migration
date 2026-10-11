import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { hasSensitiveValue, isPlainObject, parseConfigJson, sanitizeConfig, sanitizeConfigValue } from "./config.mjs";
import { validatePortablePath } from "./paths.mjs";
import { validatePackageSpec, validateResourceSpec } from "./resources.mjs";
import { ERROR_CODES, failure, success } from "./result.mjs";

const MANIFEST_KEYS = new Set(["schemaVersion", "files", "packages", "resources", "report"]);
const FILE_KEYS = new Set(["path", "size", "sha256"]);

export function createSnapshotManifest(input) {
  if (!isPlainObject(input)) return failure(ERROR_CODES.INVALID_TYPE);
  if (Object.keys(input).some((key) => !["files", "packages", "resources", "report"].includes(key))) {
    return failure(ERROR_CODES.INVALID_FORMAT);
  }
  if (!Object.hasOwn(input, "files")) return failure(ERROR_CODES.MISSING);
  if (!Array.isArray(input.files)) return failure(ERROR_CODES.INVALID_TYPE);
  const packagesInput = Object.hasOwn(input, "packages") ? input.packages : [];
  const resourcesInput = Object.hasOwn(input, "resources") ? input.resources : [];
  if (!Array.isArray(packagesInput) || !Array.isArray(resourcesInput)) return failure(ERROR_CODES.INVALID_TYPE);

  const files = [];
  const seenPaths = new Set();
  for (const file of input.files) {
    if (!isPlainObject(file)) return failure(ERROR_CODES.INVALID_TYPE);
    if (!Object.hasOwn(file, "path") || !Object.hasOwn(file, "content")) return failure(ERROR_CODES.MISSING);
    const pathResult = validatePortablePath(file.path);
    if (!pathResult.ok) return pathResult;
    const pathIdentity = pathResult.value.toLowerCase();
    if (seenPaths.has(pathIdentity)) return failure(ERROR_CODES.INVALID_FORMAT);
    const content = toBytes(file.content);
    if (!content.ok) return content;

    seenPaths.add(pathIdentity);
    files.push({
      path: pathResult.value,
      size: content.value.byteLength,
      sha256: hash(content.value),
    });
  }

  const packages = [];
  for (const packageInput of packagesInput) {
    const packageResult = validatePackageSpec(packageInput);
    if (!packageResult.ok) return packageResult;
    packages.push(packageResult.value);
  }
  const resources = [];
  for (const resourceInput of resourcesInput) {
    const resourceResult = validateResourceSpec(resourceInput);
    if (!resourceResult.ok) return resourceResult;
    resources.push(resourceResult.value);
  }
  const output = { schemaVersion: 1, files, packages, resources };
  if (Object.hasOwn(input, "report")) {
    const report = validateSnapshotReport(input.report);
    if (!report.ok) return report;
    output.report = report.value;
  }
  return success(output);
}

export function validateSnapshotManifest(input) {
  if (!isPlainObject(input)) return failure(ERROR_CODES.INVALID_TYPE);
  if (!Object.hasOwn(input, "schemaVersion")) return failure(ERROR_CODES.MISSING);
  if (typeof input.schemaVersion !== "number" || !Number.isInteger(input.schemaVersion)) {
    return failure(ERROR_CODES.INVALID_TYPE);
  }
  if (input.schemaVersion !== 1) return failure(ERROR_CODES.UNSUPPORTED_VERSION);
  if (Object.keys(input).some((key) => !MANIFEST_KEYS.has(key))) return failure(ERROR_CODES.INVALID_FORMAT);
  if (!["files", "packages", "resources"].every((key) => Object.hasOwn(input, key))) {
    return failure(ERROR_CODES.MISSING);
  }
  if (!Array.isArray(input.files) || !Array.isArray(input.packages) || !Array.isArray(input.resources)) {
    return failure(ERROR_CODES.INVALID_TYPE);
  }

  const files = [];
  const seenPaths = new Set();
  for (const file of input.files) {
    if (!isPlainObject(file)) return failure(ERROR_CODES.INVALID_TYPE);
    if (["path", "size", "sha256"].some((key) => !Object.hasOwn(file, key))) return failure(ERROR_CODES.MISSING);
    if (Object.keys(file).some((key) => !FILE_KEYS.has(key))) return failure(ERROR_CODES.INVALID_FORMAT);
    if (typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.size !== "number") {
      return failure(ERROR_CODES.INVALID_TYPE);
    }
    const pathResult = validatePortablePath(file.path);
    if (!pathResult.ok) return pathResult;
    const pathIdentity = pathResult.value.toLowerCase();
    if (seenPaths.has(pathIdentity)) return failure(ERROR_CODES.INVALID_FORMAT);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      return failure(ERROR_CODES.INVALID_FORMAT);
    }
    seenPaths.add(pathIdentity);
    files.push({ path: pathResult.value, size: file.size, sha256: file.sha256 });
  }

  const packages = [];
  for (const packageInput of input.packages) {
    const packageResult = validatePackageSpec(packageInput);
    if (!packageResult.ok) return packageResult;
    packages.push(packageResult.value);
  }
  const resources = [];
  for (const resourceInput of input.resources) {
    const resourceResult = validateResourceSpec(resourceInput);
    if (!resourceResult.ok) return resourceResult;
    resources.push(resourceResult.value);
  }
  const output = { schemaVersion: 1, files, packages, resources };
  if (Object.hasOwn(input, "report")) {
    const report = validateSnapshotReport(input.report);
    if (!report.ok) return report;
    output.report = report.value;
  }
  return success(output);
}

export async function verifySnapshotDirectory(snapshotRoot, manifestInput) {
  if (typeof snapshotRoot !== "string" || snapshotRoot.length === 0) return failure(ERROR_CODES.INVALID_TYPE);
  const manifestResult = validateSnapshotManifest(manifestInput);
  if (!manifestResult.ok) return manifestResult;

  let rootStat;
  try {
    rootStat = await lstat(snapshotRoot);
  } catch (error) {
    return failure(error?.code === "ENOENT" ? ERROR_CODES.MISSING : ERROR_CODES.INVALID_PATH);
  }
  if (rootStat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
  if (!rootStat.isDirectory()) return failure(ERROR_CODES.INVALID_TYPE);

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(snapshotRoot);
  } catch {
    return failure(ERROR_CODES.INVALID_PATH);
  }

  const verifiedFiles = [];
  for (const entry of manifestResult.value.files) {
    const resolved = await resolveSnapshotFile(canonicalRoot, entry.path);
    if (!resolved.ok) return resolved;

    let content;
    try {
      content = await readFile(resolved.value);
    } catch {
      return failure(ERROR_CODES.INVALID_PATH);
    }
    if (content.byteLength !== entry.size || hash(content) !== entry.sha256) {
      return failure(ERROR_CODES.INTEGRITY_MISMATCH);
    }
    const safeContent = sanitizeConfigurationFile(entry.path, content);
    if (!safeContent.ok) return safeContent;
    verifiedFiles.push({ path: entry.path, ...safeContent.value });
  }
  return success(verifiedFiles);
}

function sanitizeConfigurationFile(relativePath, content) {
  const text = content.toString("utf8");
  if (hasSensitiveValue(text)) return failure(ERROR_CODES.SENSITIVE_CONTENT);
  if (isPiConfigurationPath(relativePath)) {
    const parsed = parseConfigJson(text);
    if (!parsed.ok) return parsed;
    const sanitized = sanitizeConfig(parsed.value);
    if (!sanitized.ok) return sanitized;
    if (containsAbsolutePath(sanitized.value.value)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
    const safeContent = Buffer.from(`${JSON.stringify(sanitized.value.value, null, 2)}\n`, "utf8");
    return success({ content: safeContent, omittedFields: sanitized.value.omittedFields });
  }
  if (path.posix.extname(relativePath).toLowerCase() !== ".json") {
    return success({ content, omittedFields: [] });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return success({ content, omittedFields: [] });
  }
  const sanitized = sanitizeConfigValue(parsed);
  if (!sanitized.ok) return sanitized;
  if (sanitized.value.omittedFields.length === 0) return success({ content, omittedFields: [] });
  const safeContent = Buffer.from(`${JSON.stringify(sanitized.value.value, null, 2)}\n`, "utf8");
  return success({ content: safeContent, omittedFields: sanitized.value.omittedFields });
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

function validateSnapshotReport(input) {
  if (!isPlainObject(input)) return failure(ERROR_CODES.INVALID_TYPE);
  const sanitized = sanitizeConfig(input);
  if (!sanitized.ok) return sanitized;
  if (sanitized.value.omittedFields.length > 0) return failure(ERROR_CODES.INVALID_FORMAT);
  return success(sanitized.value.value);
}

function isPiConfigurationPath(relativePath) {
  const segments = relativePath.split("/");
  const fileName = segments.at(-1);
  const knownFiles = new Set(["keybindings.json", "models.json", "settings.json"]);
  const agentRoot = segments[0] === "agent" && segments.length === 2;
  const homeAgentRoot = segments[0] === "home" && segments[1] === ".pi" && segments[2] === "agent" && segments.length === 4;
  return knownFiles.has(fileName) && (agentRoot || homeAgentRoot);
}

function toBytes(input) {
  if (typeof input === "string") return success(Buffer.from(input, "utf8"));
  if (Buffer.isBuffer(input)) return success(input);
  if (input instanceof Uint8Array) return success(Buffer.from(input));
  return failure(ERROR_CODES.INVALID_TYPE);
}

function hash(input) {
  return createHash("sha256").update(input).digest("hex");
}

async function resolveSnapshotFile(root, relativePath) {
  const validation = validatePortablePath(relativePath);
  if (!validation.ok) return validation;
  const segments = relativePath.split("/");
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      return failure(error?.code === "ENOENT" ? ERROR_CODES.MISSING : ERROR_CODES.INVALID_PATH);
    }
    if (stat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
    const isLast = index === segments.length - 1;
    if (isLast ? !stat.isFile() : !stat.isDirectory()) return failure(ERROR_CODES.INVALID_TYPE);
  }

  let canonicalFile;
  try {
    canonicalFile = await realpath(current);
  } catch {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  const relative = path.relative(root, canonicalFile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  return success(canonicalFile);
}
