import { spawn as nodeSpawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ERROR_CODES, failure, success } from "./result.mjs";

const WINDOWS_ARGUMENT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$command = Get-Command -Name $env:PI_MIGRATION_CLI_PATH -CommandType Application -ErrorAction SilentlyContinue",
  "if ($null -eq $command) { exit 127 }",
  "$piArgs = ConvertFrom-Json -InputObject $env:PI_MIGRATION_ARGS_JSON",
  "& $command.Source @piArgs",
  "if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }",
  "if ($?) { exit 0 } else { exit 1 }",
].join("; ");

export function createPiPackageInstaller({ platform = process.platform, env = process.env, spawn = nodeSpawn } = {}) {
  return {
    checkAvailable(agentDir) {
      return executePiCommand(["--version"], agentDir, { platform, env, spawn });
    },
    install(source, agentDir) {
      return executePiCommand(["install", source], agentDir, { platform, env, spawn });
    },
  };
}

export function buildPiCliInvocation(args, { platform = process.platform, env = process.env, agentDir } = {}) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")
    || typeof agentDir !== "string" || agentDir.length === 0) {
    return failure(ERROR_CODES.INVALID_TYPE);
  }

  const cliPath = env.PI_CODING_AGENT_CLI || (platform === "win32" ? "pi.cmd" : "pi");
  if (platform === "win32") {
    const powershell = env.SystemRoot
      ? path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    return success({
      command: powershell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ARGUMENT_SCRIPT],
      cwd: os.tmpdir(),
      env: {
        ...env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_MIGRATION_CLI_PATH: cliPath,
        PI_MIGRATION_ARGS_JSON: JSON.stringify(args),
      },
      windowsHide: true,
      stdio: "ignore",
    });
  }
  return success({
    command: cliPath,
    args,
    cwd: os.tmpdir(),
    env: { ...env, PI_CODING_AGENT_DIR: agentDir },
    windowsHide: true,
    stdio: "ignore",
  });
}

async function executePiCommand(args, agentDir, dependencies) {
  const invocation = buildPiCliInvocation(args, dependencies);
  if (!invocation.ok) return invocation;
  return executeChild(invocation.value, dependencies.spawn);
}

function executeChild(invocation, spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        windowsHide: invocation.windowsHide,
        stdio: invocation.stdio,
      });
    } catch (error) {
      resolve(failure(error?.code === "ENOENT" ? ERROR_CODES.EXTERNAL_COMMAND_MISSING : ERROR_CODES.EXTERNAL_COMMAND_FAILED));
      return;
    }

    child.once("error", (error) => {
      resolve(failure(error?.code === "ENOENT" ? ERROR_CODES.EXTERNAL_COMMAND_MISSING : ERROR_CODES.EXTERNAL_COMMAND_FAILED));
    });
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve(success(undefined));
      else resolve(failure(exitCode === 127 ? ERROR_CODES.EXTERNAL_COMMAND_MISSING : ERROR_CODES.EXTERNAL_COMMAND_FAILED));
    });
  });
}
