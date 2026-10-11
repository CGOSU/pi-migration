import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportSnapshot } from "./lib/exporter.mjs";
import { importSnapshot } from "./lib/importer.mjs";
import { ERROR_CODES, failure, success } from "./lib/result.mjs";

const OPTION_MAP = new Map([
  ["--agent-dir", "agentDir"],
  ["--home", "home"],
  ["--snapshot-dir", "snapshotDir"],
]);

export function parseExportArguments(args) {
  return parseSubcommandArguments(args, "export");
}

export function parseImportArguments(args) {
  return parseSubcommandArguments(args, "import");
}

export function parseMigrationArguments(args) {
  if (!Array.isArray(args)) return failure(ERROR_CODES.INVALID_TYPE);
  if (args.length === 0) return failure(ERROR_CODES.MISSING);
  const command = args[0];
  if (command !== "export" && command !== "import") return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  const options = parseOptions(args.slice(1));
  if (!options.ok) return options;
  return success({ command, options: options.value });
}

function parseSubcommandArguments(args, expectedCommand) {
  const parsed = parseMigrationArguments(args);
  if (!parsed.ok) return parsed;
  if (parsed.value.command !== expectedCommand) return failure(ERROR_CODES.UNSUPPORTED_RESOURCE);
  return success(parsed.value.options);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--overwrite") {
      const optionName = argument === "--dry-run" ? "dryRun" : "overwrite";
      if (options[optionName]) return failure(ERROR_CODES.INVALID_FORMAT);
      options[optionName] = true;
      continue;
    }
    const optionName = OPTION_MAP.get(argument);
    if (!optionName) return failure(ERROR_CODES.INVALID_FORMAT);
    if (Object.hasOwn(options, optionName)) return failure(ERROR_CODES.INVALID_FORMAT);
    const value = args[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      return failure(ERROR_CODES.MISSING);
    }
    options[optionName] = value;
    index += 1;
  }
  return success(options);
}

export async function runMigrationCli(args, io = console) {
  const parsed = parseMigrationArguments(args);
  if (!parsed.ok) {
    io.error(`${parsed.error.code}: ${parsed.error.message}`);
    return 1;
  }

  const { command, options } = parsed.value;
  const result = command === "export"
    ? await exportSnapshot({ ...options, packageRoot: path.dirname(fileURLToPath(import.meta.url)) })
    : await importSnapshot({ ...options, packageRoot: path.dirname(fileURLToPath(import.meta.url)) });
  if (!result.ok) {
    io.error(`${result.error.code}: ${result.error.message}`);
    if (result.progress) io.error(JSON.stringify(result.progress, null, 2));
    if (result.report) io.error(JSON.stringify({ report: result.report }, null, 2));
    return 1;
  }
  io.log(JSON.stringify({
    operation: command,
    snapshotDir: result.value.snapshotDir,
    targetAgentDir: result.value.targetAgentDir,
    backupDir: result.value.backupDir,
    written: result.value.written,
    dryRun: result.value.dryRun ?? options.dryRun ?? false,
    report: result.value.report,
    plan: result.value.plan,
    progress: result.value.progress,
  }, null, 2));
  return 0;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = await runMigrationCli(process.argv.slice(2));
}
