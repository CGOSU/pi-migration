import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportSnapshot } from "../lib/exporter.mjs";
import { importSnapshot } from "../lib/importer.mjs";
import { buildPiCliInvocation } from "../lib/pi-cli.mjs";
import { ERROR_CODES, failure, success } from "../lib/result.mjs";
import { createSnapshotManifest } from "../lib/manifest.mjs";
import { parseImportArguments } from "../migrate.mjs";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-migration-import-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createFixture(directory, { localDependencies = {} } = {}) {
  const sourceHome = path.join(directory, "old-home");
  const sourceAgentDir = path.join(sourceHome, ".pi", "agent");
  const targetHome = path.join(directory, "new-home");
  const targetAgentDir = path.join(targetHome, ".pi", "agent");
  const packageRoot = path.join(directory, "migration-package");
  const snapshotDir = path.join(directory, "snapshot");
  for (const item of [
    sourceAgentDir,
    path.join(sourceAgentDir, "extensions"),
    path.join(sourceAgentDir, "skills", "local"),
    path.join(sourceAgentDir, "local-package", "extensions"),
    path.join(sourceHome, ".agents", "skills", "research"),
    targetHome,
    packageRoot,
  ]) {
    await mkdir(item, { recursive: true });
  }

  await writeFile(path.join(sourceAgentDir, "settings.json"), JSON.stringify({
    defaultProvider: "openai",
    defaultModel: "source-model",
    deviceId: "source-device-id",
    sessionDir: path.join(sourceHome, "sessions"),
    packages: [
      {
        source: "npm:@example/pi-tools@1.2.3",
        extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
        skills: [],
      },
      "./local-package",
    ],
    extensions: ["extensions/**/*.ts"],
    skills: ["skills"],
  }));
  await writeFile(path.join(sourceAgentDir, "keybindings.json"), JSON.stringify({ actions: { submit: "enter" } }));
  await writeFile(path.join(sourceAgentDir, "mcp.json"), JSON.stringify({
    mcpServers: { docs: { command: "npx", args: ["-y", "@example/docs-server"] } },
  }));
  await writeFile(path.join(sourceAgentDir, "models.json"), JSON.stringify({ providers: {} }));
  await writeFile(path.join(sourceAgentDir, "AGENTS.md"), "Apply the imported user instructions.");
  await writeFile(path.join(sourceAgentDir, "extensions", "local.ts"), "export default 'local extension';");
  await writeFile(path.join(sourceAgentDir, "skills", "local", "SKILL.md"), "# Local skill\nKeep this exact content.");
  await writeFile(path.join(sourceHome, ".agents", "skills", "research", "SKILL.md"), "# Research skill\nExact bytes.");
  await writeFile(path.join(sourceAgentDir, "local-package", "package.json"), JSON.stringify({
    name: "local-pi-package",
    dependencies: localDependencies,
  }));
  await writeFile(path.join(sourceAgentDir, "local-package", "extensions", "local-package.ts"), "export default 7;");

  const exported = await exportSnapshot({ home: sourceHome, agentDir: sourceAgentDir, packageRoot, snapshotDir });
  assert.equal(exported.ok, true, exported.error?.message);
  return { sourceHome, sourceAgentDir, targetHome, targetAgentDir, packageRoot, snapshotDir, exported };
}

function makeInstaller({ installResult = success(undefined), onInstall = async () => {} } = {}) {
  const calls = { check: 0, installs: [] };
  return {
    calls,
    packageInstaller: {
      async checkAvailable(agentDir) {
        calls.check += 1;
        calls.agentDir = agentDir;
        return success(undefined);
      },
      async install(source, agentDir) {
        calls.installs.push({ source, agentDir });
        await onInstall(source, agentDir);
        return installResult;
      },
    },
  };
}

async function writeTargetRuntimeState(agentDir) {
  await mkdir(path.join(agentDir, "sessions"), { recursive: true });
  await writeFile(path.join(agentDir, "auth.json"), "target-auth-canary");
  await writeFile(path.join(agentDir, "sessions", "keep.jsonl"), "target-session-canary");
}

test("import restores portable resources and filtered package settings, and remains idempotent", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    const targetMcpPath = path.join(fixture.targetAgentDir, "mcp.json");
    const targetMcpContent = JSON.stringify({ mcpServers: { target: { command: "target-only-server" } } });
    await mkdir(fixture.targetAgentDir, { recursive: true });
    await writeFile(targetMcpPath, targetMcpContent);
    let mutationCount = 0;
    const installer = makeInstaller({
      onInstall: async (_source, agentDir) => {
        mutationCount += 1;
        const settingsPath = path.join(agentDir, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        settings.packages.push({ ...settings.packages[0] });
        settings.packages[0].extensions = [];
        await writeFile(settingsPath, JSON.stringify(settings));
      },
    });

    const first = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
    }, { packageInstaller: installer.packageInstaller });

    assert.equal(first.ok, true, first.error?.message);
    assert.equal(first.value.progress.packagesInstalled.length, 1);
    assert.equal(await readFile(targetMcpPath, "utf8"), targetMcpContent);
    assert.equal(installer.calls.check, 1);
    assert.deepEqual(installer.calls.installs.map((item) => item.source), ["npm:@example/pi-tools@1.2.3"]);
    assert.equal(await readFile(path.join(fixture.targetAgentDir, "extensions", "local.ts"), "utf8"), "export default 'local extension';");
    assert.equal(await readFile(path.join(fixture.targetAgentDir, "skills", "local", "SKILL.md"), "utf8"), "# Local skill\nKeep this exact content.");
    assert.equal(await readFile(path.join(fixture.targetHome, ".agents", "skills", "research", "SKILL.md"), "utf8"), "# Research skill\nExact bytes.");

    const settingsText = await readFile(path.join(fixture.targetAgentDir, "settings.json"), "utf8");
    const settings = JSON.parse(settingsText);
    assert.equal(settings.packages.length, 2);
    assert.deepEqual(settings.packages[0], {
      source: "npm:@example/pi-tools@1.2.3",
      extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
      skills: [],
    });
    assert.equal(settings.packages[1].source, "./local-package");
    assert.equal(settingsText.includes(fixture.sourceHome), false);
    assert.equal(Object.hasOwn(settings, "deviceId"), false);
    assert.equal(Object.hasOwn(settings, "sessionDir"), false);
    assert.equal(first.value.report.omittedConfigurationFields.includes("agent/settings.json:$.deviceId"), true);
    assert.equal(first.value.report.authenticationRequired, true);

    const second = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
    }, { packageInstaller: installer.packageInstaller });
    assert.equal(second.ok, true, second.error?.message);
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.targetAgentDir, "settings.json"), "utf8")).packages, settings.packages);
    assert.equal(await readFile(targetMcpPath, "utf8"), targetMcpContent);
    assert.equal(mutationCount, 2);
  });
});

test("legacy snapshots containing MCP configuration are rejected before target writes", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    const mcpContent = Buffer.from(JSON.stringify({ mcpServers: { old: { command: "old-machine-server" } } }));
    await mkdir(path.join(fixture.snapshotDir, "agent"), { recursive: true });
    await writeFile(path.join(fixture.snapshotDir, "agent", "mcp.json"), mcpContent);
    const manifestPath = path.join(fixture.snapshotDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push({
      path: "agent/mcp.json",
      size: mcpContent.byteLength,
      sha256: createHash("sha256").update(mcpContent).digest("hex"),
    });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const targetMcpPath = path.join(fixture.targetAgentDir, "mcp.json");
    const targetMcpContent = "target MCP settings remain untouched";
    await mkdir(fixture.targetAgentDir, { recursive: true });
    await writeFile(targetMcpPath, targetMcpContent);
    const installer = makeInstaller();

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
      overwrite: true,
    }, { packageInstaller: installer.packageInstaller });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.SENSITIVE_CONTENT);
    assert.equal(result.progress.snapshotVerified, false);
    assert.equal(await readFile(targetMcpPath, "utf8"), targetMcpContent);
    assert.equal(installer.calls.check, 0);
    assert.deepEqual(installer.calls.installs, []);
    await assert.rejects(readFile(path.join(fixture.targetAgentDir, "settings.json")), { code: "ENOENT" });
  });
});

test("import dry-run creates no files, backups, or package-installer calls", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    await mkdir(fixture.targetAgentDir, { recursive: true });
    await writeTargetRuntimeState(fixture.targetAgentDir);
    const installer = makeInstaller();

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
      dryRun: true,
    }, { packageInstaller: installer.packageInstaller });

    assert.equal(result.ok, true);
    assert.equal(result.value.written, false);
    assert.equal(result.value.plan.filesToWrite.includes("agent/settings.json"), true);
    assert.equal(installer.calls.check, 0);
    assert.equal(installer.calls.installs.length, 0);
    assert.equal(await readFile(path.join(fixture.targetAgentDir, "auth.json"), "utf8"), "target-auth-canary");
    assert.equal(await readFile(path.join(fixture.targetAgentDir, "sessions", "keep.jsonl"), "utf8"), "target-session-canary");
    await assert.rejects(readFile(path.join(fixture.targetAgentDir, "extensions", "local.ts")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.targetHome, ".pi-migration-backups")), { code: "ENOENT" });
  });
});

test("invalid checksums are rejected before target changes or package checks", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    await mkdir(fixture.targetAgentDir, { recursive: true });
    await writeTargetRuntimeState(fixture.targetAgentDir);
    await writeFile(path.join(fixture.snapshotDir, "agent", "settings.json"), "tampered");
    const installer = makeInstaller();

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
      overwrite: true,
    }, { packageInstaller: installer.packageInstaller });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.INTEGRITY_MISMATCH);
    assert.deepEqual(result.progress.filesWritten, []);
    assert.equal(installer.calls.check, 0);
    assert.equal(await readFile(path.join(fixture.targetAgentDir, "auth.json"), "utf8"), "target-auth-canary");
    assert.equal(await readFile(path.join(fixture.targetAgentDir, "sessions", "keep.jsonl"), "utf8"), "target-session-canary");
  });
});

test("snapshots naming credential or session targets are rejected without modifying them", async () => {
  await withTempDirectory(async (directory) => {
    const home = path.join(directory, "target-home");
    const agentDir = path.join(home, ".pi", "agent");
    const snapshotDir = path.join(directory, "malicious-snapshot");
    await mkdir(path.join(snapshotDir, "agent"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeTargetRuntimeState(agentDir);
    const secret = "never-write-this-auth-canary";
    const content = Buffer.from(secret);
    const manifest = {
      schemaVersion: 1,
      files: [{ path: "agent/auth.json", size: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") }],
      packages: [],
      resources: [],
    };
    await writeFile(path.join(snapshotDir, "agent", "auth.json"), content);
    await writeFile(path.join(snapshotDir, "manifest.json"), JSON.stringify(manifest));

    const result = await importSnapshot({ home, agentDir, snapshotDir });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.SENSITIVE_CONTENT);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(await readFile(path.join(agentDir, "auth.json"), "utf8"), "target-auth-canary");
    assert.equal(await readFile(path.join(agentDir, "sessions", "keep.jsonl"), "utf8"), "target-session-canary");
    await assert.rejects(readFile(path.join(agentDir, "settings.json")), { code: "ENOENT" });
  });
});

test("credential-bearing target settings are never overwritten", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    await mkdir(fixture.targetAgentDir, { recursive: true });
    const secret = "target-settings-secret-canary";
    const settingsPath = path.join(fixture.targetAgentDir, "settings.json");
    const original = JSON.stringify({ providers: { openai: { apiKey: secret } } });
    await writeFile(settingsPath, original);

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
      overwrite: true,
    }, { packageInstaller: makeInstaller().packageInstaller });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.SENSITIVE_CONTENT);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(await readFile(settingsPath, "utf8"), original);
    await assert.rejects(readFile(path.join(fixture.targetAgentDir, "extensions", "local.ts")), { code: "ENOENT" });
  });
});

test("an unsafe absolute path in the snapshot is rejected before writing", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    const snapshotDir = path.join(directory, "unsafe-path-snapshot");
    const content = Buffer.from(JSON.stringify({ shellPath: "C:/old-user/Git/bin/bash.exe" }));
    const manifest = createSnapshotManifest({ files: [{ path: "agent/settings.json", content }] });
    assert.equal(manifest.ok, true);
    await mkdir(path.join(snapshotDir, "agent"), { recursive: true });
    await writeFile(path.join(snapshotDir, "agent", "settings.json"), content);
    await writeFile(path.join(snapshotDir, "manifest.json"), JSON.stringify(manifest.value));

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.UNSUPPORTED_RESOURCE);
    await assert.rejects(readFile(path.join(fixture.targetAgentDir, "settings.json")), { code: "ENOENT" });
  });
});

test("target symlink directories are rejected without following them", async (t) => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    const outside = path.join(directory, "outside-skills");
    await mkdir(outside, { recursive: true });
    try {
      await symlink(outside, path.join(fixture.targetHome, ".agents"), process.platform === "win32" ? "junction" : undefined);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        t.skip("The current Windows environment cannot create a directory junction.");
        return;
      }
      throw error;
    }
    const installer = makeInstaller();

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
    }, { packageInstaller: installer.packageInstaller });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.INVALID_PATH);
    assert.equal(installer.calls.check, 0);
    assert.deepEqual(await readdir(outside), []);
  });
});

test("conflicts reject by default; explicit overwrite backs up only affected files", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    await mkdir(fixture.targetAgentDir, { recursive: true });
    await writeTargetRuntimeState(fixture.targetAgentDir);
    const settingsPath = path.join(fixture.targetAgentDir, "settings.json");
    const originalSettings = JSON.stringify({ defaultModel: "target-only" });
    await writeFile(settingsPath, originalSettings);
    const installer = makeInstaller();
    const options = { home: fixture.targetHome, agentDir: fixture.targetAgentDir, snapshotDir: fixture.snapshotDir };

    const refused = await importSnapshot(options, { packageInstaller: installer.packageInstaller });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, ERROR_CODES.CONFLICT);
    assert.deepEqual(refused.progress.filesWritten, []);
    assert.equal(installer.calls.check, 0);
    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    await assert.rejects(readFile(path.join(fixture.targetAgentDir, "extensions", "local.ts")), { code: "ENOENT" });

    const overwritten = await importSnapshot({ ...options, overwrite: true }, { packageInstaller: installer.packageInstaller });
    assert.equal(overwritten.ok, true, overwritten.error?.message);
    assert.equal(typeof overwritten.value.progress.backupDir, "string");
    assert.deepEqual(overwritten.value.progress.backedUpFiles, ["agent/settings.json"]);
    assert.equal(await readFile(path.join(overwritten.value.progress.backupDir, "agent", "settings.json"), "utf8"), originalSettings);
    assert.equal(await readFile(path.join(fixture.targetAgentDir, "auth.json"), "utf8"), "target-auth-canary");
    assert.equal(await readFile(path.join(fixture.targetAgentDir, "sessions", "keep.jsonl"), "utf8"), "target-session-canary");
  });
});

test("missing Pi CLI is reported before target writes", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    const installer = {
      calls: 0,
      async checkAvailable() {
        this.calls += 1;
        return failure(ERROR_CODES.EXTERNAL_COMMAND_MISSING);
      },
      async install() {
        throw new Error("must not be called");
      },
    };

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
    }, { packageInstaller: installer });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.EXTERNAL_COMMAND_MISSING);
    assert.deepEqual(result.progress.filesWritten, []);
    assert.equal(installer.calls, 1);
    await assert.rejects(readFile(path.join(fixture.targetAgentDir, "settings.json")), { code: "ENOENT" });
  });
});

test("Pi installer failure is nonzero and reports files and package progress", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    const installer = makeInstaller({ installResult: failure(ERROR_CODES.EXTERNAL_COMMAND_FAILED) });

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
    }, { packageInstaller: installer.packageInstaller });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.EXTERNAL_COMMAND_FAILED);
    assert.deepEqual(result.progress.packagesInstalled, []);
    assert.deepEqual(result.progress.packagesPending, [1]);
    assert.equal(result.progress.failedPackageNumber, 1);
    assert.equal(result.progress.settingsFinalized, true);
    assert.equal(result.progress.externalPackageSideEffectsPossible, true);
    assert.equal(result.progress.filesWritten.includes("agent/settings.json"), true);
    assert.equal(JSON.parse(await readFile(path.join(fixture.targetAgentDir, "settings.json"), "utf8")).packages.length, 2);
  });
});

test("local package dependencies excluded from the snapshot fail before writes", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory, { localDependencies: { "@example/not-bundled": "^1.0.0" } });
    const installer = makeInstaller();

    const result = await importSnapshot({
      home: fixture.targetHome,
      agentDir: fixture.targetAgentDir,
      snapshotDir: fixture.snapshotDir,
    }, { packageInstaller: installer.packageInstaller });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.DEPENDENCY_MISSING);
    assert.deepEqual(result.progress.localPackageDependencies, [{ packageNumber: 2, names: ["@example/not-bundled"] }]);
    assert.equal(installer.calls.check, 0);
    await assert.rejects(readFile(path.join(fixture.targetAgentDir, "settings.json")), { code: "ENOENT" });
  });
});

test("import CLI dry-run accepts explicit target paths and does not create them", async () => {
  await withTempDirectory(async (directory) => {
    const fixture = await createFixture(directory);
    const result = spawnSync(process.execPath, [
      path.resolve("migrate.mjs"),
      "import",
      "--dry-run",
      "--home",
      fixture.targetHome,
      "--agent-dir",
      fixture.targetAgentDir,
      "--snapshot-dir",
      fixture.snapshotDir,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.operation, "import");
    assert.equal(output.dryRun, true);
    assert.equal(output.written, false);
    await assert.rejects(readFile(path.join(fixture.targetAgentDir, "settings.json")), { code: "ENOENT" });
  });
});

test("import argument parsing supports dry-run and explicit overwrite", () => {
  assert.deepEqual(parseImportArguments(["import", "--dry-run", "--overwrite", "--snapshot-dir", "C:/snapshot"]).value, {
    dryRun: true,
    overwrite: true,
    snapshotDir: "C:/snapshot",
  });
  assert.equal(parseImportArguments(["import", "--unknown"]).error.code, ERROR_CODES.INVALID_FORMAT);
});

test("Pi CLI invocation is shell-free on POSIX and safely transports Windows .cmd arguments", () => {
  const source = "git:github.com/example/package@a1b2c3d4&echo nope";
  const posix = buildPiCliInvocation(["install", source], {
    platform: "linux",
    env: {},
    agentDir: "/tmp/new-agent",
  });
  assert.equal(posix.ok, true);
  assert.equal(posix.value.command, "pi");
  assert.deepEqual(posix.value.args, ["install", source]);
  assert.equal(Object.hasOwn(posix.value, "shell"), false);

  const windows = buildPiCliInvocation(["install", source], {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    agentDir: "C:\\target\\agent",
  });
  assert.equal(windows.ok, true);
  assert.equal(windows.value.command.toLowerCase(), "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe");
  assert.equal(windows.value.env.PI_MIGRATION_CLI_PATH, "pi.cmd");
  assert.equal(windows.value.args.at(-1).includes(source), false);
  assert.equal(windows.value.env.PI_MIGRATION_ARGS_JSON, JSON.stringify(["install", source]));
  assert.equal(windows.value.env.PI_CODING_AGENT_DIR, "C:\\target\\agent");
});
