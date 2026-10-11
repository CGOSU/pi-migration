import { ERROR_CODES, failure, success } from "./result.mjs";

const SECRET_KEY_PATTERN = /(?:api.?key|token|client.?secret|password|passwd|credential|authorization|bearer|private.?key|secret|^auth$|^mcpauth$)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[^\s"'`]{8,}/i,
  /\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,}|xox[baprs]-[a-z0-9-]{10,})\b/i,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i,
  /https?:\/\/[^/\s:@]+:[^@\s/]+@/i,
  /[?&](?:api[_-]?key|access[_-]?token|token|secret|password)=[^&\s]+/i,
  /(?:^|\s)--?[a-z0-9_-]*(?:api[-_]?key|token|secret|password|authorization|credential)[a-z0-9_-]*(?:$|=|\s)/i,
  /(?:^|\s)[a-z0-9_-]*(?:api[_-]?key|token|secret|password|credential|authorization)[a-z0-9_-]*=[^\s]+/i,
  /[\"'][a-z0-9_-]*(?:api[_-]?key|token|secret|password|credential|authorization)[a-z0-9_-]*[\"']\s*:/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential|authorization)\b\s*[:=]\s*[\"'`][^\"'`]{8,}[\"'`]/i,
];
const NON_PORTABLE_KEYS = new Set([
  "deviceid",
  "lastchangelogversion",
  "sessiondir",
  "sessiondirectory",
  "sessionfile",
  "sessionid",
]);

export function parseConfigJson(input) {
  if (input === undefined) return failure(ERROR_CODES.MISSING);
  if (typeof input !== "string") return failure(ERROR_CODES.INVALID_TYPE);

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return failure(ERROR_CODES.INVALID_FORMAT);
  }
  return isPlainObject(parsed) ? success(parsed) : failure(ERROR_CODES.INVALID_TYPE);
}

export function sanitizeConfig(input) {
  if (input === undefined) return failure(ERROR_CODES.MISSING);
  if (!isPlainObject(input)) return failure(ERROR_CODES.INVALID_TYPE);
  return sanitizeConfigValue(input);
}

export function sanitizeConfigValue(input) {
  if (input === undefined) return failure(ERROR_CODES.MISSING);
  const omittedFields = [];
  const sanitized = sanitizeValue(input, "$", omittedFields, new WeakSet());
  if (!sanitized.ok) return sanitized;
  return success({ value: sanitized.value, omittedFields });
}

export function hasSensitiveValue(value) {
  return typeof value === "string" && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeValue(value, fieldPath, omittedFields, seen) {
  if (value === null || typeof value === "boolean") return success(value);
  if (typeof value === "string") {
    return hasSensitiveValue(value) ? failure(ERROR_CODES.SENSITIVE_CONTENT) : success(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? success(value) : failure(ERROR_CODES.INVALID_TYPE);
  }
  if (typeof value !== "object" || seen.has(value)) return failure(ERROR_CODES.INVALID_TYPE);
  seen.add(value);

  if (Array.isArray(value)) {
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = sanitizeValue(value[index], `${fieldPath}[${index}]`, omittedFields, seen);
      if (!item.ok) return item;
      output.push(item.value);
    }
    seen.delete(value);
    return success(output);
  }
  if (!isPlainObject(value)) return failure(ERROR_CODES.INVALID_TYPE);

  const output = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SECRET_KEY_PATTERN.test(normalizedKey)) return failure(ERROR_CODES.SENSITIVE_CONTENT);
    if (NON_PORTABLE_KEYS.has(normalizedKey)) {
      omittedFields.push(`${fieldPath}.${key}`);
      continue;
    }

    const nested = sanitizeValue(nestedValue, `${fieldPath}.${key}`, omittedFields, seen);
    if (!nested.ok) return nested;
    Object.defineProperty(output, key, {
      value: nested.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return success(output);
}
