import os from "node:os";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { createImportPlan } from "./import-plan.mjs";
import { createImportBackup, rewritePackageSettings, writeImportFiles } from "./import-writer.mjs";
import { createPiPackageInstaller } from "./pi-cli.mjs";
import { parseConfigJson } from "./config.mjs";
import { validateSnapshotManifest, verifySnapshotDirectory } from "./manifest.mjs";
import { ERROR_CODES, failure, success } from "./result.mjs";

const OPTION_NAMES = new Set(["agentDir", "dryRun", "home", "overwrite", "packageRoot", "snapshotDir"]);

export async function importSnapshot(options = {}, dependencies = {}) {
  const normalized = normalizeOptions(options);
  if (!normalized.ok) return normalized;
  const loaded = await loadSnapshot(normalized.value.snapshotDir);
  if (!loaded.ok) return failedImport(loaded, initialProgress());

  const planResult = await createImportPlan(loaded.value.manifest, loaded.value.files, normalized.value);
  if (!planResult.ok) {
    return failedImport(planResult, {
      ...initialProgress(),
      snapshotVerified: true,
      packagesPending: loaded.value.manifest.packages.map((_, index) => index + 1),
    });
  }
  const plan = planResult.value;
  const report = createImportReport(loaded.value.manifest, plan);
  const progress = {
    ...initialProgress(),
    snapshotVerified: true,
    preflightComplete: true,
    packagesPending: plan.remotePackages.map((item) => item.packageNumber),
  };

  if (plan.localDependencies.length > 0) {
    return failedImport(failure(ERROR_CODES.DEPENDENCY_MISSING), {
      ...progress,
      localPackageDependencies: plan.localDependencies,
      note: "Local package dependencies are excluded and were not installed.",
    }, report);
  }

  if (normalized.value.dryRun) {
    return success({
      snapshotDir: normalized.value.snapshotDir,
      targetAgentDir: normalized.value.agentDir,
      written: false,
      dryRun: true,
      report,
      plan: {
        filesToWrite: plan.files.filter((file) => file.status !== "unchanged").map((file) => file.portablePath),
        unchangedFiles: plan.files.filter((file) => file.status === "unchanged").map((file) => file.portablePath),
        packagesToInstall: plan.remotePackages.map((item) => item.packageNumber),
        localPackages: plan.localPackages.map((item) => item.packageNumber),
      },
      progress,
    });
  }

  const installer = resolveInstaller(dependencies);
  if (!installer.ok) return failedImport(installer, progress, report);
  if (plan.remotePackages.length > 0) {
    const available = await callInstaller(installer.value.checkAvailable.bind(installer.value), normalized.value.agentDir);
    if (!available.ok) return failedImport(available, progress, report);
  }

  const backup = await createImportBackup(plan, normalized.value.home);
  if (!backup.ok) return failedImport(backup, { ...progress, ...backup.progress }, report);
  progress.backupDir = backup.value.backupDir;
  progress.backedUpFiles = backup.value.backedUpFiles;

  const writes = await writeImportFiles(plan.files);
  if (!writes.ok) {
    return failedImport(writes, {
      ...progress,
      ...writes.progress,
      packagesInstalled: [],
      packagesPending: plan.remotePackages.map((item) => item.packageNumber),
      externalPackageSideEffectsPossible: false,
    }, report);
  }
  progress.filesWritten = [...writes.value.filesWritten];
  progress.filesUnchanged = [...writes.value.filesUnchanged];
  progress.createdDirectoriesCount = writes.value.createdDirectoriesCount;

  const installedPackages = [];
  for (let index = 0; index < plan.remotePackages.length; index += 1) {
    const packageEntry = plan.remotePackages[index];
    const installation = await callInstaller(installer.value.install.bind(installer.value), packageEntry.source, normalized.value.agentDir);
    if (!installation.ok) {
      const settingsStatus = await finalizeSettings(plan.settingsFile, progress);
      return failedImport(installation, {
        ...progress,
        packagesInstalled: installedPackages,
        packagesPending: plan.remotePackages.slice(index).map((item) => item.packageNumber),
        failedPackageNumber: packageEntry.packageNumber,
        externalPackageSideEffectsPossible: true,
        settingsFinalized: settingsStatus.ok,
        ...(settingsStatus.ok ? {} : { settingsFinalizationError: settingsStatus.error.code }),
        note: "Imported files remain in place; the installer may have partial external side effects.",
      }, report);
    }
    installedPackages.push(packageEntry.packageNumber);
  }

  const settingsStatus = plan.remotePackages.length > 0
    ? await finalizeSettings(plan.settingsFile, progress)
    : success(undefined);
  if (!settingsStatus.ok) {
    return failedImport(settingsStatus, {
      ...progress,
      packagesInstalled: installedPackages,
      packagesPending: [],
      externalPackageSideEffectsPossible: installedPackages.length > 0,
      settingsFinalized: false,
      note: "Package installation completed, but the final settings file could not be reconciled.",
    }, report);
  }

  const filesWritten = [...progress.filesWritten];
  const filesUnchanged = [...progress.filesUnchanged];
  return success({
    snapshotDir: normalized.value.snapshotDir,
    targetAgentDir: normalized.value.agentDir,
    written: filesWritten.length > 0 || installedPackages.length > 0,
    dryRun: false,
    report,
    progress: {
      ...progress,
      packagesInstalled: installedPackages,
      packagesPending: [],
      externalPackageSideEffectsPossible: installedPackages.length > 0,
      settingsFinalized: true,
      filesWritten,
      filesUnchanged,
    },
  });
}

function normalizeOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) return failure(ERROR_CODES.INVALID_TYPE);
  if (Object.keys(options).some((key) => !OPTION_NAMES.has(key))) return failure(ERROR_CODES.INVALID_FORMAT);
  for (const key of ["agentDir", "home", "packageRoot", "snapshotDir"]) {
    if (Object.hasOwn(options, key) && typeof options[key] !== "string") return failure(ERROR_CODES.INVALID_TYPE);
  }
  if (Object.hasOwn(options, "dryRun") && typeof options.dryRun !== "boolean") return failure(ERROR_CODES.INVALID_TYPE);
  if (Object.hasOwn(options, "overwrite") && typeof options.overwrite !== "boolean") return failure(ERROR_CODES.INVALID_TYPE);

  const home = path.resolve(options.home ?? os.homedir());
  const agentDir = path.resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"));
  const packageRoot = path.resolve(options.packageRoot ?? process.cwd());
  const snapshotDir = path.resolve(options.snapshotDir ?? path.join(packageRoot, ".pi-migration-snapshot"));
  return success({
    home,
    agentDir,
    packageRoot,
    snapshotDir,
    dryRun: options.dryRun ?? false,
    overwrite: options.overwrite ?? false,
  });
}

async function loadSnapshot(snapshotDir) {
  let rootStat;
  try {
    rootStat = await lstat(snapshotDir);
  } catch (error) {
    return failure(error?.code === "ENOENT" ? ERROR_CODES.MISSING : ERROR_CODES.INVALID_PATH);
  }
  if (rootStat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
  if (!rootStat.isDirectory()) return failure(ERROR_CODES.INVALID_TYPE);

  const manifestPath = path.join(snapshotDir, "manifest.json");
  let manifestStat;
  try {
    manifestStat = await lstat(manifestPath);
  } catch (error) {
    return failure(error?.code === "ENOENT" ? ERROR_CODES.MISSING : ERROR_CODES.INVALID_PATH);
  }
  if (manifestStat.isSymbolicLink()) return failure(ERROR_CODES.INVALID_PATH);
  if (!manifestStat.isFile()) return failure(ERROR_CODES.INVALID_TYPE);

  let text;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return failure(ERROR_CODES.INVALID_PATH);
  }
  const parsed = parseConfigJson(text);
  if (!parsed.ok) return parsed;
  const manifest = validateSnapshotManifest(parsed.value);
  if (!manifest.ok) return manifest;
  const files = await verifySnapshotDirectory(snapshotDir, manifest.value);
  if (!files.ok) return files;
  return success({ manifest: manifest.value, files: files.value });
}

function resolveInstaller(dependencies) {
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    return failure(ERROR_CODES.INVALID_TYPE);
  }
  const installer = dependencies.packageInstaller ?? createPiPackageInstaller();
  if (!installer || typeof installer.checkAvailable !== "function" || typeof installer.install !== "function") {
    return failure(ERROR_CODES.INVALID_TYPE);
  }
  return success(installer);
}

async function callInstaller(operation, ...arguments_) {
  try {
    const result = await operation(...arguments_);
    if (!result || typeof result.ok !== "boolean") return failure(ERROR_CODES.EXTERNAL_COMMAND_FAILED);
    if (result.ok) return success(undefined);
    if ([ERROR_CODES.EXTERNAL_COMMAND_MISSING, ERROR_CODES.EXTERNAL_COMMAND_FAILED].includes(result.error?.code)) return result;
    return failure(ERROR_CODES.EXTERNAL_COMMAND_FAILED);
  } catch {
    return failure(ERROR_CODES.EXTERNAL_COMMAND_FAILED);
  }
}

async function finalizeSettings(settingsFile, progress) {
  if (!settingsFile) return success(undefined);
  const result = await rewritePackageSettings(settingsFile, progress.filesWritten, progress.filesUnchanged);
  if (!result.ok) return result;
  progress.filesWritten = result.value.filesWritten;
  progress.filesUnchanged = result.value.filesUnchanged;
  progress.createdDirectoriesCount += result.value.createdDirectoriesCount;
  return success(undefined);
}

function createImportReport(manifest, plan) {
  const exportReport = manifest.report ?? {};
  const omitted = new Set([
    ...(Array.isArray(exportReport.omittedConfigurationFields) ? exportReport.omittedConfigurationFields : []),
    ...plan.omittedConfigurationFields,
  ]);
  return {
    ...exportReport,
    importedFileCount: plan.files.length,
    remotePackageCount: plan.remotePackages.length,
    localPackageCount: plan.localPackages.length,
    omittedConfigurationFields: [...omitted],
    localPackageDependenciesNotRestored: plan.localDependencies,
    authenticationRequired: true,
    requiredOnDestination: [
      ...(Array.isArray(exportReport.requiredOnDestination) ? exportReport.requiredOnDestination : []),
      "Authenticate separately; no credentials, login state, or sessions are restored",
      "Review and trust any restored extensions before starting Pi",
    ],
  };
}

function initialProgress() {
  return {
    snapshotVerified: false,
    preflightComplete: false,
    filesWritten: [],
    filesUnchanged: [],
    packagesInstalled: [],
    packagesPending: [],
    externalPackageSideEffectsPossible: false,
    backedUpFiles: [],
  };
}

function failedImport(result, progress, report) {
  return {
    ...result,
    progress,
    ...(report ? { report } : {}),
  };
}
