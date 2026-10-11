import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ERROR_CODES,
  createSnapshotManifest,
  normalizePackageSpec,
  parseConfigJson,
  portablePathFor,
  sanitizeConfig,
  validatePortablePath,
  validateResourceSpec,
  validateSnapshotManifest,
  verifySnapshotDirectory,
} from "../lib/snapshot-core.mjs";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-migration-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("configuration parse errors do not include raw input", () => {
  const secret = "configuration-secret-canary";
  const result = parseConfigJson(`{ invalid: "${secret}" }`);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.INVALID_FORMAT);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("configuration parser distinguishes missing and non-object input", () => {
  assert.equal(parseConfigJson(undefined).error.code, ERROR_CODES.MISSING);
  assert.equal(parseConfigJson(null).error.code, ERROR_CODES.INVALID_TYPE);
  assert.equal(parseConfigJson("[]").error.code, ERROR_CODES.INVALID_TYPE);
  assert.deepEqual(parseConfigJson('{"theme":"dark"}'), {
    ok: true,
    value: { theme: "dark" },
  });
});

test("configuration sanitizer removes host/session fields and reports them", () => {
  const result = sanitizeConfig({
    defaultModel: "model-id",
    deviceId: "machine-id",
    sessionDir: "/private/sessions",
    nested: { lastChangelogVersion: "v1" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.value, {
    defaultModel: "model-id",
    nested: {},
  });
  assert.deepEqual(result.value.omittedFields, ["$.deviceId", "$.sessionDir", "$.nested.lastChangelogVersion"]);
});

test("configuration sanitizer blocks secret fields without echoing values", () => {
  const secret = "secret-value-do-not-log";
  const result = sanitizeConfig({ providers: { openai: { apiKey: secret } } });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.SENSITIVE_CONTENT);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("configuration sanitizer detects inline credentials in command arguments and environment", () => {
  const secret = "inline-secret-do-not-log";
  const result = sanitizeConfig({ args: ["--token", secret] });
  const environment = sanitizeConfig({ args: ["--env", `SERVICE_TOKEN=${secret}`] });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.SENSITIVE_CONTENT);
  assert.equal(environment.error.code, ERROR_CODES.SENSITIVE_CONTENT);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(environment).includes(secret), false);
});

test("configuration sanitizer blocks generic credential-named MCP environment fields", () => {
  const result = sanitizeConfig({ mcpServers: { docs: { env: { DOCS_TOKEN: "${DOCS_TOKEN}" } } } });
  const authField = sanitizeConfig({ mcpServers: { docs: { auth: { mode: "oauth" } } } });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.SENSITIVE_CONTENT);
  assert.equal(authField.ok, false);
  assert.equal(authField.error.code, ERROR_CODES.SENSITIVE_CONTENT);
});

test("configuration sanitizer copies prototype-named fields without mutating objects", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"theme":"dark"}');
  const result = sanitizeConfig(input);

  assert.equal(result.ok, true);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(result.value.value, "__proto__"), true);
  assert.deepEqual(result.value.value.__proto__, { polluted: true });
});

test("configuration sanitizer rejects unsupported JavaScript values", () => {
  const result = sanitizeConfig({ value: 1n });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.INVALID_TYPE);
});

test("portable paths map known roots and reject external paths", async () => {
  await withTempDirectory(async (directory) => {
    const home = path.join(directory, "home");
    const agentDir = path.join(home, ".pi", "agent");

    assert.deepEqual(portablePathFor(path.join(agentDir, "settings.json"), { agentDir, home }), {
      ok: true,
      value: "agent/settings.json",
    });
    assert.deepEqual(portablePathFor(path.join(home, ".agents", "skills", "review", "SKILL.md"), { agentDir, home }), {
      ok: true,
      value: "home/.agents/skills/review/SKILL.md",
    });
    assert.equal(portablePathFor(path.join(directory, "outside", "extension.ts"), { agentDir, home }).error.code,
      ERROR_CODES.UNSUPPORTED_RESOURCE);
  });
});

test("portable path validation rejects traversal, absolute paths, and excluded data", () => {
  for (const input of ["../outside", "agent/../outside", "/etc/passwd", "C:/Users/name/file", "agent\\settings.json", "agent/settings.json:stream", "agent/CON.txt"]) {
    assert.equal(validatePortablePath(input).error.code, ERROR_CODES.INVALID_PATH, input);
  }

  for (const input of ["agent/auth.json", "home/.pi/agent/sessions/one.jsonl", "home/.env", "agent/node_modules/pkg/index.js"]) {
    assert.equal(validatePortablePath(input).error.code, ERROR_CODES.SENSITIVE_CONTENT, input);
  }
});

test("package normalization preserves remote declarations and resource filters", () => {
  const result = normalizePackageSpec({
    source: "git:github.com/example/pi-tools@v1",
    extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
    skills: [],
    prompts: ["prompts/review.md"],
    autoload: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    kind: "remote",
    source: "git:github.com/example/pi-tools@v1",
    filters: {
      extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
      skills: [],
      prompts: ["prompts/review.md"],
    },
    autoload: false,
  });
});

test("package normalization maps local sources and rejects unportable or unsafe sources", async () => {
  await withTempDirectory(async (directory) => {
    const home = path.join(directory, "home");
    const agentDir = path.join(home, ".pi", "agent");
    const result = normalizePackageSpec("./local-package", {
      baseDir: agentDir,
      agentDir,
      home,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { kind: "local", path: "agent/local-package" });
    assert.equal(normalizePackageSpec("https://user:password@example.test/pkg").error.code,
      ERROR_CODES.SENSITIVE_CONTENT);
    assert.equal(normalizePackageSpec("../../../../outside", { baseDir: agentDir, agentDir, home }).error.code,
      ERROR_CODES.UNSUPPORTED_RESOURCE);
    assert.equal(normalizePackageSpec({ source: "npm:example/pkg", extensions: ["../outside.ts"] }).error.code,
      ERROR_CODES.INVALID_PATH);
  });
});

test("resource specs require a supported kind and a portable path", () => {
  assert.deepEqual(validateResourceSpec({ kind: "skill", path: "home/.agents/skills/review" }), {
    ok: true,
    value: { kind: "skill", path: "home/.agents/skills/review" },
  });
  assert.equal(validateResourceSpec({ kind: "binary", path: "resources/tool" }).error.code,
    ERROR_CODES.UNSUPPORTED_RESOURCE);
  assert.equal(validateResourceSpec({ kind: "theme", path: "agent/auth.json" }).error.code,
    ERROR_CODES.SENSITIVE_CONTENT);
});

test("snapshot manifest records file size and SHA-256 and validates its schema", () => {
  const content = Buffer.from("settings-content");
  const result = createSnapshotManifest({
    files: [{ path: "agent/settings.json", content }],
    packages: [{ kind: "remote", source: "npm:example/pi-package@1.0.0" }],
    resources: [{ kind: "skill", path: "home/.agents/skills/review" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.schemaVersion, 1);
  assert.equal(result.value.files[0].size, content.byteLength);
  assert.match(result.value.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(validateSnapshotManifest(result.value).ok, true);
  assert.equal(validateSnapshotManifest({ ...result.value, schemaVersion: 999 }).error.code,
    ERROR_CODES.UNSUPPORTED_VERSION);
});

test("snapshot manifest rejects duplicate, malformed, and credential paths", () => {
  const duplicate = createSnapshotManifest({
    files: [
      { path: "agent/settings.json", content: "a" },
      { path: "agent/settings.json", content: "b" },
    ],
  });
  assert.equal(duplicate.error.code, ERROR_CODES.INVALID_FORMAT);
  assert.equal(createSnapshotManifest({
    files: [
      { path: "agent/settings.json", content: "a" },
      { path: "Agent/Settings.json", content: "b" },
    ],
  }).error.code, ERROR_CODES.INVALID_FORMAT);

  assert.equal(validateSnapshotManifest({ schemaVersion: 1, files: "wrong", packages: [], resources: [] }).error.code,
    ERROR_CODES.INVALID_TYPE);
  assert.equal(validateSnapshotManifest({ schemaVersion: 1, files: [] }).error.code, ERROR_CODES.MISSING);
  assert.equal(createSnapshotManifest({ files: [], unexpected: true }).error.code, ERROR_CODES.INVALID_FORMAT);
  assert.equal(createSnapshotManifest({ files: [{ path: "agent/auth.json", content: "credential" }] }).error.code,
    ERROR_CODES.SENSITIVE_CONTENT);
});

test("snapshot verification reads only regular non-symlink files and checks integrity", async (t) => {
  await withTempDirectory(async (directory) => {
    const snapshotRoot = path.join(directory, "snapshot");
    const content = Buffer.from('{"theme":"dark","deviceId":"machine-id"}');
    const manifestResult = createSnapshotManifest({
      files: [{ path: "agent/settings.json", content }],
    });
    assert.equal(manifestResult.ok, true);

    await mkdir(path.join(snapshotRoot, "agent"), { recursive: true });
    await writeFile(path.join(snapshotRoot, "agent", "settings.json"), content);
    const verified = await verifySnapshotDirectory(snapshotRoot, manifestResult.value);
    assert.equal(verified.ok, true);
    assert.deepEqual(JSON.parse(verified.value[0].content), { theme: "dark" });
    assert.deepEqual(verified.value[0].omittedFields, ["$.deviceId"]);

    await writeFile(path.join(snapshotRoot, "agent", "settings.json"), "tampered");
    const tampered = await verifySnapshotDirectory(snapshotRoot, manifestResult.value);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.error.code, ERROR_CODES.INTEGRITY_MISMATCH);

    await rm(path.join(snapshotRoot, "agent", "settings.json"));
    const missing = await verifySnapshotDirectory(snapshotRoot, manifestResult.value);
    assert.equal(missing.error.code, ERROR_CODES.MISSING);

    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "settings.json"), content);
    await rm(path.join(snapshotRoot, "agent"), { recursive: true });
    try {
      await symlink(outside, path.join(snapshotRoot, "agent"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        t.skip("Host does not permit creating directory symlinks for this test.");
        return;
      }
      throw error;
    }
    const linked = await verifySnapshotDirectory(snapshotRoot, manifestResult.value);
    assert.equal(linked.ok, false);
    assert.equal(linked.error.code, ERROR_CODES.INVALID_PATH);
  });
});

test("snapshot verification blocks credential-bearing Pi configuration", async () => {
  await withTempDirectory(async (directory) => {
    const secret = "settings-secret-canary";
    const content = Buffer.from(JSON.stringify({ providers: { openai: { apiKey: secret } } }));
    const manifest = createSnapshotManifest({ files: [{ path: "agent/settings.json", content }] });
    assert.equal(manifest.ok, true);
    await mkdir(path.join(directory, "agent"), { recursive: true });
    await writeFile(path.join(directory, "agent", "settings.json"), content);

    const result = await verifySnapshotDirectory(directory, manifest.value);
    assert.equal(result.error.code, ERROR_CODES.SENSITIVE_CONTENT);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });
});

test("snapshot verification does not expose file contents in failures", async () => {
  await withTempDirectory(async (directory) => {
    const secret = "snapshot-secret-canary";
    const manifest = {
      schemaVersion: 1,
      files: [{
        path: "agent/resource.txt",
        size: Buffer.byteLength(secret),
        sha256: "0".repeat(64),
      }],
      packages: [],
      resources: [],
    };
    await mkdir(path.join(directory, "agent"), { recursive: true });
    await writeFile(path.join(directory, "agent", "resource.txt"), secret);

    const result = await verifySnapshotDirectory(directory, manifest);
    assert.equal(result.error.code, ERROR_CODES.INTEGRITY_MISMATCH);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });
});
