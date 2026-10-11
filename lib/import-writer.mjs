import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateExistingContent } from "./import-plan.mjs";
import { ERROR_CODES, failure, success } from "./result.mjs";

export async function createImportBackup(plan, home) {
  const replacements = plan.files.filter((file) => file.status === "replace");
  if (replacements.length === 0) return success({ backupDir: undefined, backedUpFiles: [] });

  const backupRoot = path.join(home, ".pi-migration-backups");
  const stagingDir = path.join(backupRoot, `.stage-${randomUUID()}`);
  const backupDir = path.join(backupRoot, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  const createdDirectories = new Set();
  try {
    const root = await ensureDirectory(backupRoot, home, createdDirectories);
    if (!root.ok) return withBackupProgress(root, createdDirectories);
    await mkdir(stagingDir, { mode: 0o700 });
    const entries = [];
    for (const file of replacements) {
      const target = path.join(stagingDir, ...file.portablePath.split("/"));
      const parentResult = await ensureDirectory(path.dirname(target), stagingDir, createdDirectories);
      if (!parentResult.ok) return withBackupProgress(parentResult, createdDirectories);
      await writeFile(target, file.existingContent, { flag: "wx", mode: 0o600 });
      entries.push({
        path: file.portablePath,
        size: file.existingContent.byteLength,
        sha256: hash(file.existingContent),
      });
    }
    await writeFile(path.join(stagingDir, "backup-manifest.json"), serializeJson({ schemaVersion: 1, files: entries }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(stagingDir, backupDir);
    return success({ backupDir, backedUpFiles: replacements.map((file) => file.portablePath) });
  } catch {
    return {
      ...failure(ERROR_CODES.INVALID_PATH),
      progress: { backupCreated: false, createdDirectoriesCount: createdDirectories.size },
    };
  } finally {
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch {
      // A failed staged backup is never treated as the user's backup.
    }
  }
}

export async function writeImportFiles(files) {
  const progress = { filesWritten: [], filesUnchanged: [], createdDirectories: new Set() };
  for (const file of files) {
    const result = await writeImportFile(file, progress);
    if (!result.ok) return failedWrite(result.error.code, progress);
  }
  return success({
    filesWritten: [...progress.filesWritten],
    filesUnchanged: [...progress.filesUnchanged],
    createdDirectoriesCount: progress.createdDirectories.size,
  });
}

export async function rewritePackageSettings(settingsFile, filesWritten = [], filesUnchanged = []) {
  const progress = {
    filesWritten: [...filesWritten],
    filesUnchanged: [...filesUnchanged],
    createdDirectories: new Set(),
  };
  const result = await writeImportFile(settingsFile, progress, { allowExternalChange: true });
  if (!result.ok) return failedWrite(result.error.code, progress);
  return success({
    filesWritten: [...progress.filesWritten],
    filesUnchanged: [...progress.filesUnchanged],
    createdDirectoriesCount: progress.createdDirectories.size,
  });
}

async function writeImportFile(file, progress, { allowExternalChange = false } = {}) {
  const parentResult = await ensureDirectory(path.dirname(file.targetPath), file.rootPath, progress.createdDirectories);
  if (!parentResult.ok) return parentResult;
  const targetResult = await inspectTargetFile(file.targetPath);
  if (!targetResult.ok) return targetResult;

  if (targetResult.value.exists) {
    let currentContent;
    try {
      currentContent = await readFile(file.targetPath);
    } catch {
      return failure(ERROR_CODES.INVALID_PATH);
    }
    if (currentContent.equals(file.content)) {
      if (!progress.filesWritten.includes(file.portablePath)) addUnique(progress.filesUnchanged, file.portablePath);
      return success(undefined);
    }
    if (file.status === "replace" && !allowExternalChange && !currentContent.equals(file.existingContent)) {
      return failure(ERROR_CODES.CONFLICT);
    }
    if (file.status !== "replace" && !allowExternalChange) return failure(ERROR_CODES.CONFLICT);
    const safeContent = validateExistingContent(file.portablePath, currentContent);
    if (!safeContent.ok) return safeContent;
  } else if (file.status === "replace" && !allowExternalChange) {
    return failure(ERROR_CODES.CONFLICT);
  }

  const temporaryPath = path.join(path.dirname(file.targetPath), `.${path.basename(file.targetPath)}.pi-import-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, file.content, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, file.targetPath);
    addUnique(progress.filesWritten, file.portablePath);
    return success(undefined);
  } catch {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // A uniquely named temporary file is not treated as an imported file.
    }
    return failure(ERROR_CODES.INVALID_PATH);
  }
}

async function inspectTargetFile(targetPath) {
  let stat;
  try {
    stat = await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return success({ exists: false });
    return failure(ERROR_CODES.INVALID_PATH);
  }
  if (stat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
  return stat.isFile() ? success({ exists: true }) : failure(ERROR_CODES.INVALID_TYPE);
}

async function ensureDirectory(target, root, createdDirectories) {
  const rootCheck = await ensureAbsoluteDirectory(root, createdDirectories);
  if (!rootCheck.ok) return rootCheck;
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  let current = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") return failure(ERROR_CODES.INVALID_PATH);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch {
        return failure(ERROR_CODES.INVALID_PATH);
      }
      createdDirectories.add(current);
      try {
        stat = await lstat(current);
      } catch {
        return failure(ERROR_CODES.INVALID_PATH);
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure(ERROR_CODES.INVALID_PATH);
  }
  return success(undefined);
}

async function ensureAbsoluteDirectory(target, createdDirectories) {
  const absolute = path.resolve(target);
  let current = absolute;
  let existingStat;
  while (true) {
    try {
      existingStat = await lstat(current);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") return failure(ERROR_CODES.INVALID_PATH);
      const parent = path.dirname(current);
      if (parent === current) return failure(ERROR_CODES.INVALID_PATH);
      current = parent;
    }
  }
  if (existingStat.isSymbolicLink() || !existingStat.isDirectory()) return failure(ERROR_CODES.INVALID_PATH);

  const segments = path.relative(current, absolute).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") return failure(ERROR_CODES.INVALID_PATH);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch {
        return failure(ERROR_CODES.INVALID_PATH);
      }
      createdDirectories.add(current);
      try {
        stat = await lstat(current);
      } catch {
        return failure(ERROR_CODES.INVALID_PATH);
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure(ERROR_CODES.INVALID_PATH);
  }
  return success(undefined);
}

function withBackupProgress(result, createdDirectories) {
  return {
    ...result,
    progress: { backupCreated: false, createdDirectoriesCount: createdDirectories.size },
  };
}

function failedWrite(code, progress) {
  return {
    ...failure(code),
    progress: {
      filesWritten: [...progress.filesWritten],
      filesUnchanged: [...progress.filesUnchanged],
      createdDirectoriesCount: progress.createdDirectories.size,
    },
  };
}

function addUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function serializeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
