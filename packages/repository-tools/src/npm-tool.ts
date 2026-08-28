import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ALLOWED_NPM_SCRIPTS = [
  "check:public-boundary",
  "typecheck"
] as const;

export type AllowedNpmScript = (typeof ALLOWED_NPM_SCRIPTS)[number];

export interface VerificationReceipt {
  script: AllowedNpmScript;
  exitCode: 0;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutLines: number;
  stderrLines: number;
  truncated: boolean;
}

export function isAllowedNpmScript(script: string): script is AllowedNpmScript {
  return (ALLOWED_NPM_SCRIPTS as readonly string[]).includes(script);
}

export function verificationEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const allowed = [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE"
  ] as const;
  const sanitized: NodeJS.ProcessEnv = {
    CI: "1",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false"
  };
  for (const key of allowed) {
    const value = environment[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function commandFor(
  repositoryRoot: string,
  script: AllowedNpmScript
): { command: string; args: string[] } {
  if (script === "check:public-boundary") {
    return {
      command: process.execPath,
      args: [resolve(repositoryRoot, "scripts", "check-public-boundary.mjs")]
    };
  }
  return {
    command: process.execPath,
    args: [
      resolve(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
      "-b",
      "--pretty",
      "false"
    ]
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineCount(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  return value.split(/\r?\n/u).length;
}

export async function runNpmScript(
  repositoryRoot: string,
  script: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<VerificationReceipt> {
  if (!isAllowedNpmScript(script)) {
    throw new Error("script is not in the fixed verification allowlist");
  }

  const invocation = commandFor(repositoryRoot, script);
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4_000_000,
    timeout: Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 600_000)),
    windowsHide: true,
    shell: false,
    env: verificationEnvironment(),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });

  const limit = 100_000;
  return {
    script,
    exitCode: 0,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    stdoutLines: lineCount(result.stdout),
    stderrLines: lineCount(result.stderr),
    truncated: result.stdout.length + result.stderr.length > limit
  };
}
