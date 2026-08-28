import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ALLOWED_NPM_SCRIPTS = [
  "check:public-boundary",
  "typecheck",
  "test",
  "build",
  "verify",
  "ingest:fixture"
] as const;

export type AllowedNpmScript = (typeof ALLOWED_NPM_SCRIPTS)[number];

export function isAllowedNpmScript(script: string): script is AllowedNpmScript {
  return (ALLOWED_NPM_SCRIPTS as readonly string[]).includes(script);
}

export async function runNpmScript(
  repositoryRoot: string,
  script: string,
  options: { timeoutMs?: number; npmCliPath?: string } = {}
): Promise<{ script: AllowedNpmScript; exitCode: 0; stdout: string; stderr: string; truncated: boolean }> {
  if (!isAllowedNpmScript(script)) {
    throw new Error("script is not in the fixed npm allowlist");
  }

  const npmCliPath = options.npmCliPath ?? process.env.npm_execpath;
  if (npmCliPath === undefined || npmCliPath.length === 0) {
    throw new Error("npm CLI path is unavailable; start the app through npm");
  }

  const result = await execFileAsync(process.execPath, [npmCliPath, "run", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4_000_000,
    timeout: Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 600_000)),
    windowsHide: true,
    env: { ...process.env, npm_config_update_notifier: "false" }
  });

  const combinedLength = result.stdout.length + result.stderr.length;
  const limit = 100_000;
  return {
    script,
    exitCode: 0,
    stdout: result.stdout.slice(0, limit),
    stderr: result.stderr.slice(0, Math.max(0, limit - Math.min(limit, result.stdout.length))),
    truncated: combinedLength > limit
  };
}
