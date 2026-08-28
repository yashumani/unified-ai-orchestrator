import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { assertPublicPath, resolveSafeRepositoryPath } from "./path-safety.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 100_000;
const CREDENTIAL_SHAPES = [
  /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bAIza[A-Za-z0-9_-]{30,}\b/u,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/u,
  /["']?(?:password|passwd|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?(?!example\b|placeholder\b|redacted\b|unknown\b|none\b)[^\s"',;}{]{12,}/iu
] as const;

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function bounded(value: string, limit = MAX_COMMAND_OUTPUT): {
  content: string;
  truncated: boolean;
} {
  return value.length <= limit
    ? { content: value, truncated: false }
    : { content: value.slice(0, limit), truncated: true };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("Repository read was cancelled.", "AbortError");
  }
}

function hasCredentialShape(content: string): boolean {
  return CREDENTIAL_SHAPES.some((pattern) => pattern.test(content));
}

async function git(
  repositoryRoot: string,
  args: string[],
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  const result = await execFileAsync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 2_000_000,
    timeout: 20_000,
    ...(signal === undefined ? {} : { signal }),
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      PATHEXT: process.env.PATHEXT,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0"
    }
  });
  throwIfAborted(signal);
  return result.stdout;
}

async function trackedPathSet(
  repositoryRoot: string,
  signal?: AbortSignal
): Promise<Set<string>> {
  return new Set(
    (await git(repositoryRoot, ["ls-files", "-z"], signal))
      .split("\0")
      .filter(Boolean)
      .map((path) => path.replaceAll("\\", "/"))
  );
}

async function assertTrackedPath(
  repositoryRoot: string,
  relativePath: string,
  signal?: AbortSignal
): Promise<void> {
  const tracked = await trackedPathSet(repositoryRoot, signal);
  if (!tracked.has(relativePath.replaceAll("\\", "/"))) {
    throw new Error("repository reads are limited to tracked public files");
  }
}

function safeDiffContent(content: string): string {
  return hasCredentialShape(content)
    ? "[credential-shaped diff content omitted]\n"
    : content;
}

export interface ListedFiles {
  files: string[];
  truncated: boolean;
}

export async function listRepositoryFiles(
  repositoryRoot: string,
  options: {
    prefix?: string | undefined;
    limit?: number | undefined;
    signal?: AbortSignal | undefined;
  } = {}
): Promise<ListedFiles> {
  throwIfAborted(options.signal);
  const limit = Math.max(1, Math.min(options.limit ?? 500, 2_000));
  const prefix = options.prefix === undefined ? undefined : assertPublicPath(options.prefix);
  const output = await git(repositoryRoot, ["ls-files", "-z"], options.signal);
  const publicFiles: string[] = [];

  for (const path of output.split("\0").filter(Boolean)) {
    throwIfAborted(options.signal);
    try {
      const safePath = assertPublicPath(path);
      if (prefix === undefined || safePath === prefix || safePath.startsWith(`${prefix}/`)) {
        publicFiles.push(safePath);
      }
    } catch {
      // Protected tracked paths are intentionally invisible to model tools.
    }
  }

  return {
    files: publicFiles.slice(0, limit),
    truncated: publicFiles.length > limit
  };
}

export interface ReadRepositoryFileResult {
  path: string;
  content: string;
  contentSha256: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export async function readRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
  options: {
    startLine?: number | undefined;
    lineCount?: number | undefined;
    signal?: AbortSignal | undefined;
  } = {}
): Promise<ReadRepositoryFileResult> {
  throwIfAborted(options.signal);
  const safe = await resolveSafeRepositoryPath(repositoryRoot, relativePath);
  await assertTrackedPath(repositoryRoot, safe.relativePath, options.signal);
  const bytes = await readFile(safe.absolutePath, {
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  throwIfAborted(options.signal);
  if (bytes.includes(0)) {
    throw new Error("binary files are not supported");
  }
  if (bytes.byteLength > 2_000_000) {
    throw new Error("file exceeds the 2 MB read limit");
  }

  const fullContent = bytes.toString("utf8");
  if (hasCredentialShape(fullContent)) {
    throw new Error("credential-shaped file content is protected");
  }
  const lines = fullContent.split(/\r?\n/u);
  const startLine = Math.max(1, options.startLine ?? 1);
  const lineCount = Math.max(1, Math.min(options.lineCount ?? 200, 1_000));
  const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);

  return {
    path: safe.relativePath,
    content: selected.join("\n"),
    contentSha256: sha256(bytes),
    startLine,
    endLine: Math.min(lines.length, startLine - 1 + selected.length),
    totalLines: lines.length,
    truncated: startLine > 1 || startLine - 1 + selected.length < lines.length
  };
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export async function searchRepository(
  repositoryRoot: string,
  query: string,
  options: {
    limit?: number | undefined;
    caseSensitive?: boolean | undefined;
    signal?: AbortSignal | undefined;
  } = {}
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  throwIfAborted(options.signal);
  if (query.length === 0 || query.length > 1_000) {
    throw new Error("search query must contain 1 to 1000 characters");
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const inventory = await listRepositoryFiles(repositoryRoot, {
    limit: 2_000,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const needle = options.caseSensitive === true ? query : query.toLocaleLowerCase("en-US");
  const matches: SearchMatch[] = [];

  for (const path of inventory.files) {
    throwIfAborted(options.signal);
    let result: ReadRepositoryFileResult;
    try {
      result = await readRepositoryFile(repositoryRoot, path, {
        lineCount: 1_000,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw error;
      }
      continue;
    }
    for (const [index, line] of result.content.split("\n").entries()) {
      const haystack = options.caseSensitive === true ? line : line.toLocaleLowerCase("en-US");
      if (haystack.includes(needle)) {
        matches.push({ path, line: index + 1, text: line.slice(0, 2_000) });
        if (matches.length >= limit) {
          return { matches, truncated: true };
        }
      }
    }
  }

  return { matches, truncated: inventory.truncated };
}

export interface GitStatusResult {
  branch: string;
  clean: boolean;
  stagedCount: number;
  unstagedCount: number;
  conflictCount: number;
  entries: string[];
  protectedEntriesOmitted: boolean;
  untrackedEntriesOmitted: boolean;
  content: string;
  truncated: boolean;
}

const CONFLICT_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const MAX_STATUS_ENTRIES = 500;

export async function getGitStatus(
  repositoryRoot: string,
  signal?: AbortSignal
): Promise<GitStatusResult> {
  const branch = await git(repositoryRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD"
  ], signal);
  const raw = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ], signal);
  const fields = raw.split("\0").filter((field) => field.length > 0);
  const tracked = await trackedPathSet(repositoryRoot, signal);
  const entries: string[] = [];
  let protectedEntryOmitted = false;
  let untrackedEntryOmitted = false;
  let stagedCount = 0;
  let unstagedCount = 0;
  let conflictCount = 0;
  let entriesTruncated = false;

  for (let index = 0; index < fields.length; index += 1) {
    throwIfAborted(signal);
    const record = fields[index] as string;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = status.includes("R") || status.includes("C");
    const previousPath = renamed ? fields[index + 1] : undefined;
    if (renamed) {
      index += 1;
    }
    if (
      status === "??" ||
      (!tracked.has(path.replaceAll("\\", "/")) &&
        (previousPath === undefined ||
          !tracked.has(previousPath.replaceAll("\\", "/"))))
    ) {
      untrackedEntryOmitted = true;
      continue;
    }
    try {
      const safePath = assertPublicPath(path);
      const safePrevious =
        previousPath === undefined ? undefined : assertPublicPath(previousPath);
      const conflict = CONFLICT_STATUSES.has(status) || status.includes("U");
      const staged = !conflict && status[0] !== " " && status[0] !== "?";
      const unstaged = !conflict && status[1] !== " " && status[1] !== "?";
      if (conflict) {
        conflictCount += 1;
      }
      if (staged) {
        stagedCount += 1;
      }
      if (unstaged) {
        unstagedCount += 1;
      }
      const category = conflict
        ? "conflict"
        : staged && unstaged
          ? "staged and unstaged"
          : staged
            ? "staged"
            : "unstaged";
      if (entries.length < MAX_STATUS_ENTRIES) {
        entries.push(
          safePrevious === undefined
            ? `${category}: ${JSON.stringify(safePath)}`
            : `${category}: ${JSON.stringify(safePath)} renamed from ${JSON.stringify(safePrevious)}`
        );
      } else {
        entriesTruncated = true;
      }
    } catch {
      protectedEntryOmitted = true;
    }
  }

  const branchName = branch.trim();
  const clean = fields.length === 0;
  const lines = [
    `Branch: ${branchName}`,
    `Clean working tree: ${String(clean)}`,
    `Public tracked changes: ${stagedCount} staged, ${unstagedCount} unstaged, ${conflictCount} conflicted.`,
    `Untracked entries are present but their names are omitted: ${String(untrackedEntryOmitted)}.`,
    `Protected entries are present but their names are omitted: ${String(protectedEntryOmitted)}.`,
    ...entries
  ];
  if (protectedEntryOmitted) {
    lines.push("[protected repository entries omitted]");
  }
  if (untrackedEntryOmitted) {
    lines.push("[untracked repository entries omitted]");
  }
  if (entriesTruncated) {
    lines.push(`[public tracked entries truncated after ${MAX_STATUS_ENTRIES}]`);
  }
  const boundedContent = bounded(lines.join("\n"));
  return {
    branch: branchName,
    clean,
    stagedCount,
    unstagedCount,
    conflictCount,
    entries,
    protectedEntriesOmitted: protectedEntryOmitted,
    untrackedEntriesOmitted: untrackedEntryOmitted,
    content: boundedContent.content,
    truncated: boundedContent.truncated || entriesTruncated
  };
}

export async function getGitDiff(
  repositoryRoot: string,
  relativePath?: string,
  signal?: AbortSignal
): Promise<{ content: string; truncated: boolean }> {
  throwIfAborted(signal);
  const baseArgs = ["diff", "--no-ext-diff", "--no-textconv"];
  if (relativePath !== undefined) {
    const safePath = assertPublicPath(relativePath);
    await assertTrackedPath(repositoryRoot, safePath, signal);
    const [unstaged, staged] = await Promise.all([
      git(repositoryRoot, [...baseArgs, "--", safePath], signal),
      git(repositoryRoot, [...baseArgs, "--cached", "--", safePath], signal)
    ]);
    return bounded(safeDiffContent(`${unstaged}${staged}`));
  }

  const [unstagedNames, stagedNames] = await Promise.all([
    git(repositoryRoot, ["diff", "--name-only", "-z", "--no-ext-diff"], signal),
    git(repositoryRoot, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-ext-diff"
    ], signal)
  ]);
  const changed = [...new Set(`${unstagedNames}${stagedNames}`.split("\0").filter(Boolean))];
  const publicPaths: string[] = [];
  let protectedEntryOmitted = false;
  for (const path of changed) {
    throwIfAborted(signal);
    try {
      publicPaths.push(assertPublicPath(path));
    } catch {
      protectedEntryOmitted = true;
    }
  }

  const pieces: string[] = [];
  let truncated = publicPaths.length > 200;
  for (const path of publicPaths.slice(0, 200)) {
    throwIfAborted(signal);
    const [unstaged, staged] = await Promise.all([
      git(repositoryRoot, [...baseArgs, "--", path], signal),
      git(repositoryRoot, [...baseArgs, "--cached", "--", path], signal)
    ]);
    pieces.push(safeDiffContent(`${unstaged}${staged}`));
    if (pieces.join("").length > MAX_COMMAND_OUTPUT) {
      truncated = true;
      break;
    }
  }
  if (protectedEntryOmitted) {
    pieces.push("\n[protected repository diffs omitted]\n");
  }
  const result = bounded(pieces.join(""));
  return { content: result.content, truncated: result.truncated || truncated };
}
