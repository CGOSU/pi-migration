import { hasSensitiveValue, isPlainObject } from "./config.mjs";
import { isLocalPath, portablePathFor, resolveLocalPath, validatePortablePath } from "./paths.mjs";
import { ERROR_CODES, failure, success } from "./result.mjs";

const FILTER_NAMES = ["extensions", "skills", "prompts", "themes"];
const RESOURCE_KINDS = new Set(["skill", "extension", "prompt", "theme"]);
const PACKAGE_KEYS = new Set(["source", "extensions", "skills", "prompts", "themes", "autoload"]);

export function normalizePackageSpec(input, options = {}) {
  if (typeof input !== "string" && !isPlainObject(input)) return failure(ERROR_CODES.INVALID_TYPE);
  const source = typeof input === "string" ? input : input.source;
  if (source === undefined) return failure(ERROR_CODES.MISSING);
  if (typeof source !== "string" || source.length === 0) return failure(ERROR_CODES.INVALID_TYPE);
  if (typeof input !== "string" && Object.keys(input).some((key) => !PACKAGE_KEYS.has(key))) {
    return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  }

  const filters = {};
  if (typeof input !== "string") {
    for (const name of FILTER_NAMES) {
      if (!Object.hasOwn(input, name)) continue;
      const validated = validateFilterList(input[name]);
      if (!validated.ok) return validated;
      filters[name] = validated.value;
    }
    if (Object.hasOwn(input, "autoload") && typeof input.autoload !== "boolean") {
      return failure(ERROR_CODES.INVALID_TYPE);
    }
  }

  if (hasSensitiveValue(source)) return failure(ERROR_CODES.SENSITIVE_CONTENT);
  const spec = {};
  if (Object.keys(filters).length > 0) spec.filters = filters;
  if (typeof input !== "string" && Object.hasOwn(input, "autoload")) spec.autoload = input.autoload;

  if (isRemoteSource(source)) {
    spec.kind = "remote";
    spec.source = source;
    return success(spec);
  }
  if (!isLocalPath(source)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  if (typeof options.baseDir !== "string" || options.baseDir.length === 0) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);

  const resolved = resolveLocalPath(source, options.baseDir);
  if (resolved === null) return failure(ERROR_CODES.INVALID_PATH);
  const portable = portablePathFor(resolved, options);
  if (!portable.ok) return failure(portable.error.code === ERROR_CODES.INVALID_PATH
    ? ERROR_CODES.INVALID_PATH
    : ERROR_CODES.UNSUPPORTED_RESOURCE);

  spec.kind = "local";
  spec.path = portable.value;
  return success(spec);
}

export function validatePackageSpec(input) {
  if (!isPlainObject(input)) return failure(ERROR_CODES.INVALID_TYPE);
  if (input.kind !== "remote" && input.kind !== "local") return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  const allowedKeys = new Set(["kind", "source", "path", "filters", "autoload"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return failure(ERROR_CODES.INVALID_FORMAT);

  let output;
  if (input.kind === "remote") {
    if (input.source === undefined) return failure(ERROR_CODES.MISSING);
    if (typeof input.source !== "string") return failure(ERROR_CODES.INVALID_TYPE);
    if (hasSensitiveValue(input.source)) return failure(ERROR_CODES.SENSITIVE_CONTENT);
    if (!isRemoteSource(input.source)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
    output = { kind: "remote", source: input.source };
  } else {
    if (input.path === undefined) return failure(ERROR_CODES.MISSING);
    const pathResult = validatePortablePath(input.path);
    if (!pathResult.ok) return pathResult;
    output = { kind: "local", path: pathResult.value };
  }

  if (input.filters !== undefined) {
    if (!isPlainObject(input.filters)) return failure(ERROR_CODES.INVALID_TYPE);
    if (Object.keys(input.filters).some((key) => !FILTER_NAMES.includes(key))) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
    const filters = {};
    for (const [name, value] of Object.entries(input.filters)) {
      const validated = validateFilterList(value);
      if (!validated.ok) return validated;
      filters[name] = validated.value;
    }
    output.filters = filters;
  }
  if (input.autoload !== undefined) {
    if (typeof input.autoload !== "boolean") return failure(ERROR_CODES.INVALID_TYPE);
    output.autoload = input.autoload;
  }
  return success(output);
}

export function validateResourceSpec(input) {
  if (!isPlainObject(input)) return failure(ERROR_CODES.INVALID_TYPE);
  if (input.kind === undefined || input.path === undefined) return failure(ERROR_CODES.MISSING);
  if (!RESOURCE_KINDS.has(input.kind)) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  if (Object.keys(input).some((key) => key !== "kind" && key !== "path")) return failure(ERROR_CODES.INVALID_FORMAT);
  const pathResult = validatePortablePath(input.path);
  if (!pathResult.ok) return pathResult;
  return success({ kind: input.kind, path: pathResult.value });
}

function validateFilterList(input) {
  if (!Array.isArray(input)) return failure(ERROR_CODES.INVALID_TYPE);
  const output = [];
  for (const filter of input) {
    if (typeof filter !== "string" || filter.length === 0 || /[\\\u0000-\u001f\u007f]/.test(filter)) {
      return failure(ERROR_CODES.INVALID_TYPE);
    }
    const pattern = /^[!+-]/.test(filter) ? filter.slice(1) : filter;
    if (pattern.length === 0 || pattern.startsWith("/") || /^[a-z]:/i.test(pattern)) return failure(ERROR_CODES.INVALID_PATH);
    if (pattern.split("/").some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
      return failure(ERROR_CODES.INVALID_PATH);
    }
    if (hasSensitiveValue(filter)) return failure(ERROR_CODES.SENSITIVE_CONTENT);
    output.push(filter);
  }
  return success(output);
}

function isRemoteSource(source) {
  if (/^npm:.+$/i.test(source) || /^git:.+$/i.test(source)) return true;
  if (!/^https:\/\//i.test(source)) return false;
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
