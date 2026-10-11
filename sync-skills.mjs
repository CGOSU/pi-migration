import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, "skills-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const dryRun = process.argv.includes("--dry-run");

if (manifest.schemaVersion !== 1 || manifest.targetAgent !== "pi" || manifest.installationScope !== "global") {
  throw new Error(`Unsupported migration manifest: ${manifestPath}`);
}
if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
  throw new Error("The migration manifest contains no skills.");
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

for (const skill of manifest.skills) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(skill.source)) {
    throw new Error(`Invalid skill entry in manifest: ${JSON.stringify(skill)}`);
  }

  const args = [
    "--yes", "skills", "add", skill.source,
    "--skill", skill.name,
    "--global",
    "--agent", manifest.targetAgent,
    "--yes"
  ];
  console.log(`${dryRun ? "[dry-run] " : ""}Install ${skill.name} from ${skill.source} for ${manifest.targetAgent} (global)`);

  if (dryRun) continue;

  const result = spawnSync(npx, args, {
    cwd: here,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Installation failed for ${skill.name} (exit code ${result.status ?? "unknown"}).`);
  }
}

console.log(dryRun ? "Dry run complete; no changes were made." : "All manifest skills were processed.");
