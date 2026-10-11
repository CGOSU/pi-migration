import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportSnapshot } from "../lib/exporter.mjs";
import { ERROR_CODES } from "../lib/result.mjs";
import { parseExportArguments } from "../migrate.mjs";
import { verifySnapshotDirectory } from "../lib/manifest.mjs";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-migration-export-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createSourceFixture(directory) {
  const home = path.join(directory, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const packageRoot = path.join(directory, "migration-package");
  const snapshotDir = path.join(directory, "export", "snapshot");
  const paths = [
    agentDir,
    path.join(agentDir, "extensions"),
    path.join(agentDir, "skills", "personal"),
    path.join(agentDir, "prompts"),
    path.join(agentDir, "themes"),
    path.join(agentDir, "local-package", "extensions"),
    path.join(home, ".agents", "skills", "research"),
    path.join(home, "custom-themes"),
    packageRoot,
  ];
  for (const item of paths) await mkdir(item, { recursive: true });

  const settings = {
    defaultProvider: "openai",
    defaultModel: "example-model",
    deviceId: "machine-only-id",
    sessionDir: path.join(home, "private-sessions"),
    packages: [
      "npm:@example/unpinned-tools",
      {
        source: "git:github.com/example/pinned-tools@a1b2c3d4",
        extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
        skills: [],
      },
      "./local-package",
    ],
    extensions: ["builtin:mcp", "extensions/**/*.ts", "!extensions/legacy.ts"],
    skills: ["skills"],
    themes: ["~/custom-themes/*.json"],
  };
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  await writeFile(path.join(agentDir, "keybindings.json"), JSON.stringify({ actions: { submit: "enter" } }));
  await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: { docs: { command: "npx", args: ["-y", "@example/docs-server"] } },
  }));
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  await writeFile(path.join(agentDir, "AGENTS.md"), "Use the project instructions.");
  await writeFile(path.join(agentDir, "auth.json"), "auth-secret-canary");
  await writeFile(path.join(agentDir, "mcp-auth.json"), "oauth-secret-canary");
  await mkdir(path.join(agentDir, "sessions"), { recursive: true });
  await writeFile(path.join(agentDir, "sessions", "session.jsonl"), "session-secret-canary");
  await writeFile(path.join(agentDir, "extensions", "custom.ts"), "export default 1;");
  await writeFile(path.join(agentDir, "extensions", ".env"), "INLINE_TOKEN=excluded-secret");
  await mkdir(path.join(agentDir, "extensions", "node_modules", "dependency"), { recursive: true });
  await writeFile(path.join(agentDir, "extensions", "node_modules", "dependency", "index.js"), "ignored");
  await writeFile(path.join(agentDir, "skills", "personal", "SKILL.md"), "# Personal skill\nUse locally installed content.");
  await writeFile(path.join(home, ".agents", "skills", "research", "SKILL.md"), "# Research skill\nExact source bytes.");
  await writeFile(path.join(home, "custom-themes", "custom.json"), JSON.stringify({ name: "custom", colors: {} }));
  await writeFile(path.join(agentDir, "local-package", "package.json"), JSON.stringify({ name: "local-pi-package" }));
  await writeFile(path.join(agentDir, "local-package", "extensions", "local.ts"), "export default 2;");
  return { home, agentDir, packageRoot, snapshotDir };
}

test("export writes a portable manifest and selected configuration/resources", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createSourceFixture(directory);
    const result = await exportSnapshot(fixture);

    assert.equal(result.ok, true);
    assert.equal(result.value.written, true);
    assert.equal(result.value.manifest.schemaVersion, 1);
    assert.equal(result.value.report.remotePackages, 2);
    assert.equal(result.value.report.localPackages, 1);
    assert.equal(result.value.report.unpinnedRemotePackages, 1);
    assert.equal(result.value.report.omittedConfigurationFieldCount, 2);
    assert.deepEqual(result.value.report.omittedConfigurationFields, [
      "agent/settings.json:$.deviceId",
      "agent/settings.json:$.sessionDir",
    ]);
    assert.deepEqual(result.value.report.unpinnedRemotePackageNumbers, [1]);
    assert.deepEqual(result.value.report.includedConfigurationFiles, ["settings.json", "keybindings.json", "mcp.json", "models.json"]);
    assert.deepEqual(result.value.report.includedInstructionFiles, ["AGENTS.md"]);
    assert.equal(result.value.report.includedResourceRoots.some((resource) => resource.path === "home/.agents/skills"), true);
    assert.equal(result.value.report.requiredOnDestination.some((item) => item.includes("ChatGPT Plus")), true);

    const diskManifest = JSON.parse(await readFile(path.join(fixture.snapshotDir, "manifest.json"), "utf8"));
    assert.deepEqual(diskManifest, result.value.manifest);
    const verified = await verifySnapshotDirectory(fixture.snapshotDir, diskManifest);
    assert.equal(verified.ok, true);
    assert.equal(verified.value.length, diskManifest.files.length);

    const filePaths = new Set(diskManifest.files.map((file) => file.path));
    assert.equal(filePaths.has("agent/settings.json"), true);
    assert.equal(filePaths.has("agent/AGENTS.md"), true);
    assert.equal(filePaths.has("agent/extensions/custom.ts"), true);
    assert.equal(filePaths.has("agent/local-package/extensions/local.ts"), true);
    assert.equal(filePaths.has("home/.agents/skills/research/SKILL.md"), true);
    assert.equal(filePaths.has("home/custom-themes/custom.json"), true);
    assert.equal([...filePaths].some((file) => /(?:auth|session|node_modules|\.env)/i.test(file)), false);

    const settings = JSON.parse(await readFile(path.join(fixture.snapshotDir, "agent", "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(settings, "deviceId"), false);
    assert.equal(Object.hasOwn(settings, "sessionDir"), false);
    assert.equal(Object.hasOwn(settings, "packages"), false);
    assert.deepEqual(settings.extensions, ["builtin:mcp", "extensions/**/*.ts", "!extensions/legacy.ts"]);
    assert.deepEqual(settings.themes, ["~/custom-themes/*.json"]);
    assert.deepEqual(diskManifest.packages[1].filters, {
      extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
      skills: [],
    });

    const allSnapshotBytes = (await Promise.all(diskManifest.files.map((entry) => readFile(path.join(fixture.snapshotDir, ...entry.path.split("/")))))).map((value) => value.toString("utf8")).join("\n");
    for (const secret of ["auth-secret-canary", "oauth-secret-canary", "session-secret-canary", "excluded-secret"]) {
      assert.equal(allSnapshotBytes.includes(secret), false);
    }
  });
});

test("dry-run builds a report without creating the snapshot directory", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createSourceFixture(directory);
    const result = await exportSnapshot({ ...fixture, dryRun: true });

    assert.equal(result.ok, true);
    assert.equal(result.value.written, false);
    assert.equal(result.value.report.includedFiles > 0, true);
    await assert.rejects(readFile(path.join(fixture.snapshotDir, "manifest.json")), { code: "ENOENT" });
  });
});

test("credential-bearing configuration fails before publishing and preserves an older snapshot", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createSourceFixture(directory);
    const first = await exportSnapshot(fixture);
    assert.equal(first.ok, true);
    const previousManifest = await readFile(path.join(fixture.snapshotDir, "manifest.json"), "utf8");

    const secret = "mcp-config-secret-canary";
    await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({
      mcpServers: { docs: { env: { DOCS_TOKEN: secret } } },
    }));
    const failed = await exportSnapshot({ ...fixture, overwrite: true });

    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, ERROR_CODES.SENSITIVE_CONTENT);
    assert.deepEqual(failed.progress, { snapshotPublished: false, previousDestinationPreserved: true });
    assert.equal(JSON.stringify(failed).includes(secret), false);
    assert.equal(await readFile(path.join(fixture.snapshotDir, "manifest.json"), "utf8"), previousManifest);
  });
});

test("existing destination requires explicit overwrite and is retained as a backup", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createSourceFixture(directory);
    await mkdir(fixture.snapshotDir, { recursive: true });
    const sentinelPath = path.join(fixture.snapshotDir, "keep-me.txt");
    await writeFile(sentinelPath, "existing user data");

    const refused = await exportSnapshot(fixture);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, ERROR_CODES.CONFLICT);
    assert.deepEqual(refused.progress, { snapshotPublished: false, previousDestinationPreserved: true });
    assert.equal(await readFile(sentinelPath, "utf8"), "existing user data");

    const replaced = await exportSnapshot({ ...fixture, overwrite: true });
    assert.equal(replaced.ok, true);
    assert.equal(typeof replaced.value.backupDir, "string");
    assert.equal(await readFile(path.join(replaced.value.backupDir, "keep-me.txt"), "utf8"), "existing user data");
    assert.equal(await readFile(path.join(fixture.snapshotDir, "manifest.json"), "utf8").then((value) => value.length > 0), true);
  });
});

test("external resource paths are rejected instead of silently omitted", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createSourceFixture(directory);
    const outside = path.join(directory, "outside-skill");
    await mkdir(outside);
    const settingsPath = path.join(fixture.agentDir, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.skills = [outside];
    await writeFile(settingsPath, JSON.stringify(settings));

    const result = await exportSnapshot(fixture);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.UNSUPPORTED_RESOURCE);
    await assert.rejects(readFile(path.join(fixture.snapshotDir, "manifest.json")), { code: "ENOENT" });
  });
});

test("export rejects a configured resource path that crosses a symlink", async (t) => {
  await withTempDirectory(async (directory) => {
    const fixture = await createSourceFixture(directory);
    const outside = path.join(directory, "outside-resource");
    const link = path.join(fixture.agentDir, "linked-resource");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "SKILL.md"), "do not follow this link");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : undefined);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        t.skip("The current Windows environment cannot create a directory junction.");
        return;
      }
      throw error;
    }

    const settingsPath = path.join(fixture.agentDir, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.skills = [link];
    await writeFile(settingsPath, JSON.stringify(settings));
    const result = await exportSnapshot(fixture);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.INVALID_PATH);
  });
});

test("export rejects config values with absolute local paths", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createSourceFixture(directory);
    await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({
      mcpServers: { local: { command: path.join(directory, "private", "server.exe"), args: [] } },
    }));

    const result = await exportSnapshot(fixture);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.UNSUPPORTED_RESOURCE);
  });
});

test("CLI argument parser distinguishes missing, malformed, and unsupported options", () => {
  assert.equal(parseExportArguments([]).error.code, ERROR_CODES.MISSING);
  assert.equal(parseExportArguments(["import"]).error.code, ERROR_CODES.UNSUPPORTED_RESOURCE);
  assert.equal(parseExportArguments(["export", "--home"]).error.code, ERROR_CODES.MISSING);
  assert.equal(parseExportArguments(["export", "--unknown"]).error.code, ERROR_CODES.INVALID_FORMAT);
  assert.deepEqual(parseExportArguments(["export", "--dry-run", "--overwrite", "--home", "C:/temp/home"]).value, {
    dryRun: true,
    overwrite: true,
    home: "C:/temp/home",
  });
});

test("CLI dry-run uses explicit directories and prints no source secrets", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createSourceFixture(directory);
    const script = path.resolve("migrate.mjs");
    const result = spawnSync(process.execPath, [
      script,
      "export",
      "--dry-run",
      "--home",
      fixture.home,
      "--agent-dir",
      fixture.agentDir,
      "--snapshot-dir",
      fixture.snapshotDir,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.written, false);
    assert.equal(output.report.requiredOnDestination.includes("Authenticate separately on the new computer"), true);
    assert.equal(result.stdout.includes("auth-secret-canary"), false);
    await assert.rejects(readFile(path.join(fixture.snapshotDir, "manifest.json")), { code: "ENOENT" });
  });
});
