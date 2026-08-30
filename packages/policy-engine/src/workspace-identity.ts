import {
  DevelopmentBranchPatternSchema,
  WorkspaceIdentitySchema,
  type DevelopmentBranchPattern,
  type WorkspaceIdentity
} from "@unified-ai/contracts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export const DEFAULT_DEVELOPMENT_BRANCH_PATTERNS = [
  "dev",
  "dev-*",
  "feature/*",
  "codex/*",
  "codex_ys/*",
  "backup/*"
] as const satisfies readonly DevelopmentBranchPattern[];

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024;

export type WorkspaceIdentityErrorCode =
  | "repository_mismatch"
  | "origin_mismatch"
  | "protected_branch"
  | "branch_not_allowed";

export class WorkspaceIdentityError extends Error {
  public readonly code: WorkspaceIdentityErrorCode;

  public constructor(code: WorkspaceIdentityErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceIdentityError";
    this.code = code;
  }
}

function trimRemotePath(pathname: string): string {
  const normalized = pathname.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/");
  const withoutLeadingSlash = normalized.replace(/^\/+|\/+$/gu, "");
  const withoutGitSuffix = withoutLeadingSlash.replace(/\.git$/iu, "");

  if (
    withoutGitSuffix.length === 0 ||
    withoutGitSuffix.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new WorkspaceIdentityError(
      "origin_mismatch",
      "Git origin has an invalid repository path."
    );
  }

  return withoutGitSuffix;
}

/**
 * Produces a stable, credential-free remote identity. HTTP(S), Git, SSH, and
 * SCP-style Git remotes are accepted. Ambiguous local-path remotes fail closed.
 */
export function normalizeGitOrigin(origin: string): string {
  const value = origin.trim();
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WorkspaceIdentityError(
      "origin_mismatch",
      "Git origin is missing or contains control characters."
    );
  }

  const scpMatch = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/u.exec(value);
  if (
    scpMatch !== null &&
    !value.includes("://") &&
    !/^[A-Za-z]:[\\/]/u.test(value)
  ) {
    const host = scpMatch[1]?.replace(/^\[|\]$/gu, "").toLowerCase();
    const remotePath = scpMatch[2];
    if (host === undefined || remotePath === undefined) {
      throw new WorkspaceIdentityError("origin_mismatch", "Git origin is invalid.");
    }
    return `ssh://${host}/${trimRemotePath(remotePath)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkspaceIdentityError(
      "origin_mismatch",
      "Git origin must be an HTTP(S), Git, SSH, or SCP-style remote."
    );
  }

  const protocol = parsed.protocol.toLowerCase();
  const normalizedProtocol = protocol === "git+ssh:" ? "ssh:" : protocol;
  if (!["https:", "http:", "ssh:", "git:"].includes(normalizedProtocol)) {
    throw new WorkspaceIdentityError(
      "origin_mismatch",
      `Git origin protocol ${protocol} is not allowed.`
    );
  }
  if (parsed.hostname.length === 0) {
    throw new WorkspaceIdentityError("origin_mismatch", "Git origin host is missing.");
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port.length > 0 ? `:${parsed.port}` : "";
  const remotePath = trimRemotePath(parsed.pathname);
  return `${normalizedProtocol}//${host}${port}/${remotePath}`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprintGitOrigin(origin: string): string {
  return sha256Text(normalizeGitOrigin(origin));
}

export function canonicalPathKey(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathsReferToSameLocation(first: string, second: string): boolean {
  return canonicalPathKey(first) === canonicalPathKey(second);
}

export function isPathInsideOrEqual(root: string, target: string): boolean {
  const rootKey = canonicalPathKey(root);
  const targetKey = canonicalPathKey(target);
  return targetKey === rootKey || targetKey.startsWith(`${rootKey}${sep}`);
}

export function isProtectedBranch(branch: string): boolean {
  const normalized = branch.trim().toLowerCase();
  return (
    normalized === "main" ||
    normalized === "master" ||
    normalized.startsWith("release/")
  );
}

export function matchesDevelopmentBranch(
  branch: string,
  patterns: readonly DevelopmentBranchPattern[] = DEFAULT_DEVELOPMENT_BRANCH_PATTERNS
): boolean {
  if (branch.length === 0 || isProtectedBranch(branch)) {
    return false;
  }

  return patterns.some((pattern) => {
    DevelopmentBranchPatternSchema.parse(pattern);
    if (pattern === "dev") {
      return branch === "dev";
    }
    if (pattern === "dev-*") {
      return branch.startsWith("dev-") && branch.length > "dev-".length;
    }

    const prefix = pattern.slice(0, -1);
    return branch.startsWith(prefix) && branch.length > prefix.length;
  });
}

function runGit(repositoryRoot: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(
      "git",
      [...args],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout) => {
        if (error !== null) {
          rejectOutput(error);
          return;
        }
        resolveOutput(stdout.trim());
      }
    );
  });
}

export async function resolveWorkspaceIdentity(
  configuredRepositoryRoot: string
): Promise<WorkspaceIdentity> {
  if (configuredRepositoryRoot.trim().length === 0) {
    throw new WorkspaceIdentityError(
      "repository_mismatch",
      "Configured repository root is empty."
    );
  }

  let canonicalConfiguredRoot: string;
  try {
    canonicalConfiguredRoot = await realpath(resolve(configuredRepositoryRoot));
  } catch {
    throw new WorkspaceIdentityError(
      "repository_mismatch",
      "Configured repository root does not resolve to an existing directory."
    );
  }

  let reportedGitRoot: string;
  try {
    reportedGitRoot = await runGit(canonicalConfiguredRoot, [
      "rev-parse",
      "--show-toplevel"
    ]);
  } catch {
    throw new WorkspaceIdentityError(
      "repository_mismatch",
      "Configured repository root is not a readable Git worktree."
    );
  }

  let canonicalGitRoot: string;
  try {
    canonicalGitRoot = await realpath(
      isAbsolute(reportedGitRoot)
        ? reportedGitRoot
        : resolve(canonicalConfiguredRoot, reportedGitRoot)
    );
  } catch {
    throw new WorkspaceIdentityError(
      "repository_mismatch",
      "Git reported a repository root that cannot be resolved."
    );
  }

  if (!pathsReferToSameLocation(canonicalConfiguredRoot, canonicalGitRoot)) {
    throw new WorkspaceIdentityError(
      "repository_mismatch",
      "Configured repository root does not equal the canonical Git root."
    );
  }

  let rawOrigin: string;
  try {
    rawOrigin = await runGit(canonicalGitRoot, [
      "config",
      "--get",
      "remote.origin.url"
    ]);
  } catch {
    throw new WorkspaceIdentityError(
      "origin_mismatch",
      "Git origin is missing or unreadable."
    );
  }

  const origin = normalizeGitOrigin(rawOrigin);

  let branch: string;
  try {
    branch = await runGit(canonicalGitRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD"
    ]);
  } catch {
    throw new WorkspaceIdentityError(
      "branch_not_allowed",
      "Detached HEAD or an unreadable branch is not allowed."
    );
  }

  if (branch.length === 0) {
    throw new WorkspaceIdentityError(
      "branch_not_allowed",
      "Current Git branch is empty."
    );
  }

  return WorkspaceIdentitySchema.parse({
    repositoryRoot: canonicalGitRoot,
    origin,
    originSha256: sha256Text(origin),
    branch,
    protectedBranch: isProtectedBranch(branch)
  });
}
