import path from "node:path";
import { ERROR_CODES, failure, success } from "./result.mjs";

const SENSITIVE_NAMES = new Set([
  ".git",
  ".aws",
  ".azure",
  ".docker",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pi-migration-backups",
  ".pi-migration-snapshot",
  ".ssh",
  "auth",
  "auth.json",
  "cache",
  "caches",
  "collaborating-agents",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "keychain",
  "keychains",
  "known_hosts",
  "log",
  "logs",
  "mcp-auth",
  "mcp-auth.json",
  "mcp.json",
  "node_modules",
  "oauth.json",
  "runtime",
  "secret",
  "secret.json",
  "secrets",
  "session",
  "sessions",
  "token.json",
  "tokens",
  "tokens.json",
  "trust.json",
]);
const SENSITIVE_EXTENSIONS = [".db", ".duckdb", ".key", ".log", ".p12", ".pfx", ".pem", ".sqlite", ".sqlite3"];

export function validatePortablePath(input) {
  if (typeof input !== "string") return failure(ERROR_CODES.INVALID_TYPE);
  if (input.length === 0 || input.includes("\0") || input.includes("\\") || input.startsWith("/")) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  if (/^[a-z]:/i.test(input) || input.startsWith("//")) return failure(ERROR_CODES.INVALID_PATH);

  const segments = input.split("/");
  if (segments.some((segment) => segment.length === 0
    || segment === "."
    || segment === ".."
    || /[\u0001-\u001f\u007f<>:"|?*]/.test(segment)
    || /[. ]$/.test(segment)
    || isReservedWindowsName(segment))) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  if (segments.some(isSensitiveName)) return failure(ERROR_CODES.SENSITIVE_CONTENT);
  return success(input);
}

export function portablePathFor(sourcePath, roots = {}) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return failure(ERROR_CODES.INVALID_TYPE);
  const sourceApi = pathApiFor(sourcePath);
  if (!sourceApi.isAbsolute(sourcePath)) return failure(ERROR_CODES.INVALID_PATH);

  for (const [rootName, rootPath] of [["agent", roots.agentDir], ["home", roots.home]]) {
    if (typeof rootPath !== "string" || rootPath.length === 0) continue;
    const api = pathApiFor(rootPath);
    if (api !== sourceApi || !api.isAbsolute(rootPath)) continue;

    const relative = api.relative(api.resolve(rootPath), api.resolve(sourcePath));
    if (relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))) {
      const portable = [rootName, ...relative.split(api.sep).filter(Boolean)].join("/");
      const validated = validatePortablePath(portable);
      return validated.ok ? validated : failure(validated.error.code);
    }
  }
  return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
}

export function isLocalPath(source) {
  return path.isAbsolute(source)
    || path.win32.isAbsolute(source)
    || source.startsWith("./")
    || source.startsWith("../")
    || source.startsWith(".\\")
    || source.startsWith("..\\");
}

export function resolveLocalPath(source, baseDir) {
  const sourceApi = pathApiFor(source);
  if (sourceApi.isAbsolute(source)) return sourceApi.resolve(source);
  const baseApi = pathApiFor(baseDir);
  if (sourceApi !== baseApi) return null;
  return baseApi.resolve(baseDir, source);
}

function pathApiFor(value) {
  return path.win32.isAbsolute(value) ? path.win32 : path;
}

function isReservedWindowsName(segment) {
  const baseName = segment.split(".", 1)[0].toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/.test(baseName);
}

function isSensitiveName(segment) {
  const normalized = segment.toLowerCase();
  if (SENSITIVE_NAMES.has(normalized)) return true;
  if (normalized.startsWith(".pi-migration-snapshot.") || normalized.startsWith(".pi-migration-backup-")) return true;
  if (normalized === ".env" || normalized.startsWith(".env.")) return true;
  return SENSITIVE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}
