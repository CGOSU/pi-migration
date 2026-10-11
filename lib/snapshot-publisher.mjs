import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifySnapshotDirectory } from "./manifest.mjs";
import { validatePortablePath } from "./paths.mjs";
import { ERROR_CODES, failure, success } from "./result.mjs";

export async function publishSnapshot(snapshotDir, files, manifest, overwrite = false) {
  const parent = path.dirname(snapshotDir);
  const baseName = path.basename(snapshotDir);
  const stagingDir = path.join(parent, `${baseName}.stage-${randomUUID()}`);
  let backupDir;
  try {
    await mkdir(parent, { recursive: true });
    await mkdir(stagingDir, { recursive: false, mode: 0o700 });
    for (const file of files) {
      const validated = validatePortablePath(file.path);
      if (!validated.ok) return failedPublication(validated.error.code);
      const target = path.join(stagingDir, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
    }
    await writeFile(path.join(stagingDir, "manifest.json"), serializeJson(manifest), { flag: "wx", mode: 0o600 });
    const verified = await verifySnapshotDirectory(stagingDir, manifest);
    if (!verified.ok) return failedPublication(verified.error.code);

    try {
      const destinationStat = await lstat(snapshotDir);
      if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        return failedPublication(ERROR_CODES.INVALID_PATH);
      }
      if (!overwrite) return failedPublication(ERROR_CODES.CONFLICT);
      backupDir = path.join(parent, `${baseName}.backup-${randomUUID()}`);
      await rename(snapshotDir, backupDir);
    } catch (error) {
      if (error?.code !== "ENOENT") return failedPublication(ERROR_CODES.INVALID_PATH);
      backupDir = undefined;
    }

    try {
      await rename(stagingDir, snapshotDir);
    } catch {
      if (backupDir) {
        try {
          await rename(backupDir, snapshotDir);
          backupDir = undefined;
        } catch {
          return failedPublication(ERROR_CODES.INVALID_PATH, {
            previousDestinationPreserved: false,
            backupDir,
          });
        }
      }
      return failedPublication(ERROR_CODES.INVALID_PATH);
    }
    return success({ backupDir });
  } catch {
    return failedPublication(ERROR_CODES.INVALID_PATH, {
      previousDestinationPreserved: backupDir === undefined,
      backupDir,
    });
  } finally {
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch {
      // Staging names are distinct from published snapshots and are never reported as complete.
    }
  }
}

function failedPublication(code, details = {}) {
  return {
    ...failure(code),
    progress: {
      snapshotPublished: false,
      previousDestinationPreserved: true,
      ...details,
    },
  };
}

function serializeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
