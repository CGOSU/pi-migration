import os from "node:os";
import path from "node:path";
import { collectSnapshotSources } from "./exporter-collector.mjs";
import { createSnapshotManifest } from "./manifest.mjs";
import { publishSnapshot } from "./snapshot-publisher.mjs";
import { ERROR_CODES, failure, success } from "./result.mjs";

const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const OPTION_NAMES = new Set(["agentDir", "dryRun", "home", "overwrite", "packageRoot", "snapshotDir"]);

export async function exportSnapshot(options = {}) {
  const normalized = normalizeOptions(options);
  if (!normalized.ok) return normalized;
  const sources = await collectSnapshotSources(normalized.value);
  if (!sources.ok) return failedBeforePublish(sources);

  const reportInput = {
    files: sources.value.files.map(({ path: filePath }) => ({ path: filePath })),
    packages: sources.value.packages,
    resources: sources.value.resources,
  };
  const report = createReport(sources.value.report, reportInput);
  const manifest = createSnapshotManifest({
    files: sources.value.files,
    packages: sources.value.packages,
    resources: sources.value.resources,
    report,
  });
  if (!manifest.ok) return failedBeforePublish(manifest);
  if (normalized.value.dryRun) {
    return success({ manifest: manifest.value, report, snapshotDir: normalized.value.snapshotDir, written: false });
  }

  const published = await publishSnapshot(
    normalized.value.snapshotDir,
    sources.value.files,
    manifest.value,
    normalized.value.overwrite,
  );
  if (!published.ok) return published;
  return success({
    manifest: manifest.value,
    report,
    snapshotDir: normalized.value.snapshotDir,
    written: true,
    backupDir: published.value.backupDir,
  });
}

function failedBeforePublish(result) {
  return {
    ...result,
    progress: { snapshotPublished: false, previousDestinationPreserved: true },
  };
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

function createReport(collectionReport, manifest) {
  const remotePackages = manifest.packages.filter((item) => item.kind === "remote");
  const unpinnedPackageNumbers = remotePackages.flatMap((item, index) => hasPinnedReference(item.source) ? [] : [index + 1]);
  const includedConfigurationFiles = manifest.files
    .filter((file) => path.posix.dirname(file.path) === "agent" && ["settings.json", "keybindings.json", "mcp.json", "models.json"].includes(path.posix.basename(file.path)))
    .map((file) => path.posix.basename(file.path));
  const includedInstructionFiles = manifest.files
    .filter((file) => path.posix.dirname(file.path) === "agent" && /^(?:AGENTS(?:\.override)?\.md|CLAUDE\.md|SYSTEM\.md|APPEND_SYSTEM\.md)$/i.test(path.posix.basename(file.path)))
    .map((file) => path.posix.basename(file.path));
  const requiredOnDestination = [
    "Pi must already be installed",
    "Install packages listed in the manifest; package dependencies are not bundled",
    "Authenticate separately on the new computer",
    "Verify provider availability after login; ChatGPT Plus compatibility is not guaranteed",
  ];
  if (unpinnedPackageNumbers.length > 0) {
    requiredOnDestination.push(`Review unpinned remote package references: ${unpinnedPackageNumbers.join(", ")}`);
  }
  return {
    includedFiles: manifest.files.length,
    includedResources: manifest.resources.length,
    includedCategories: [
      { category: "Pi configuration files", count: includedConfigurationFiles.length },
      { category: "user instruction files", count: includedInstructionFiles.length },
      { category: "local resource roots", count: manifest.resources.length },
      { category: "package declarations", count: manifest.packages.length },
    ],
    includedConfigurationFiles,
    includedInstructionFiles,
    includedResourceRoots: manifest.resources,
    remotePackages: remotePackages.length,
    localPackages: manifest.packages.length - remotePackages.length,
    unpinnedRemotePackages: unpinnedPackageNumbers.length,
    unpinnedRemotePackageNumbers: unpinnedPackageNumbers,
    omittedConfigurationFields: collectionReport.omittedConfigFields,
    omittedConfigurationFieldCount: collectionReport.omittedConfigFields.length,
    excluded: ["credentials and login state", "sessions and trust decisions", "caches, logs, databases, runtime state and node_modules/dependencies"],
    skippedSensitivePaths: collectionReport.skippedSensitivePaths,
    skippedSymlinks: collectionReport.skippedSymlinks,
    skippedOtherEntries: collectionReport.skippedOtherEntries,
    requiredOnDestination,
  };
}

function hasPinnedReference(source) {
  if (source.startsWith("npm:")) {
    const packageSpec = source.slice("npm:".length);
    const versionIndex = packageSpec.lastIndexOf("@");
    if (versionIndex <= packageSpec.lastIndexOf("/")) return false;
    return PACKAGE_VERSION_PATTERN.test(packageSpec.slice(versionIndex + 1));
  }
  if (source.startsWith("git:") || source.startsWith("https://")) return /(?:@|#)[a-f0-9]{7,40}$/i.test(source);
  return false;
}
