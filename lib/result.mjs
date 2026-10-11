export const ERROR_CODES = Object.freeze({
  MISSING: "MISSING",
  INVALID_FORMAT: "INVALID_FORMAT",
  INVALID_TYPE: "INVALID_TYPE",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  SENSITIVE_CONTENT: "SENSITIVE_CONTENT",
  INVALID_PATH: "INVALID_PATH",
  CONFLICT: "CONFLICT",
  DEPENDENCY_MISSING: "DEPENDENCY_MISSING",
  EXTERNAL_COMMAND_MISSING: "EXTERNAL_COMMAND_MISSING",
  EXTERNAL_COMMAND_FAILED: "EXTERNAL_COMMAND_FAILED",
  INTEGRITY_MISMATCH: "INTEGRITY_MISMATCH",
  UNSUPPORTED_RESOURCE: "UNSUPPORTED_RESOURCE",
});

const ERROR_MESSAGES = Object.freeze({
  [ERROR_CODES.MISSING]: "Required migration data is missing.",
  [ERROR_CODES.INVALID_FORMAT]: "Migration data has an invalid format.",
  [ERROR_CODES.INVALID_TYPE]: "Migration data has an invalid type.",
  [ERROR_CODES.UNSUPPORTED_VERSION]: "Migration data uses an unsupported schema version.",
  [ERROR_CODES.SENSITIVE_CONTENT]: "Migration data contains content excluded from transfer.",
  [ERROR_CODES.INVALID_PATH]: "Migration path is invalid or unsafe.",
  [ERROR_CODES.CONFLICT]: "Migration destination already exists; explicit overwrite is required.",
  [ERROR_CODES.DEPENDENCY_MISSING]: "A required package dependency is not included in the snapshot.",
  [ERROR_CODES.EXTERNAL_COMMAND_MISSING]: "The required Pi command is not available.",
  [ERROR_CODES.EXTERNAL_COMMAND_FAILED]: "The Pi package installer failed; inspect its state before retrying.",
  [ERROR_CODES.INTEGRITY_MISMATCH]: "Snapshot file integrity verification failed.",
  [ERROR_CODES.UNSUPPORTED_RESOURCE]: "Resource cannot be represented portably.",
});

export function success(value) {
  return { ok: true, value };
}

export function failure(code) {
  const safeCode = Object.hasOwn(ERROR_MESSAGES, code) ? code : ERROR_CODES.INVALID_FORMAT;
  return { ok: false, error: { code: safeCode, message: ERROR_MESSAGES[safeCode] } };
}
