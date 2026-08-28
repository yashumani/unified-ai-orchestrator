import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { assertPublicPath, resolveSafeRepositoryPath } from "./path-safety.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT = 100_000;

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

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 2_000_000,
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  });
  return result.stdout;
}

export interface ListedFiles {
  files: string[];
  truncated: boolean;
}

export async function listRepositoryFiles(
  repositoryRoot: string,
  options: { prefix?: string | undefined; limit?: number | undefined } = {}
): Promise<ListedFiles> {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 2_000));
  const prefix = options.prefix === undefined ? undefined : assertPublicPath(options.prefix);
  const output = await git(repositoryRoot, ["ls-files", "-z"]);
  const publicFiles: string[] = [];

  for (const path of output.split("\0").filter(Boolean)) {
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
  options: { startLine?: number | undefined; lineCount?: number | undefined } = {}
): Promise<ReadRepositoryFileResult> {
  const safe = await resolveSafeRepositoryPath(repositoryRoot, relativePath);
  const bytes = await readFile(safe.absolutePath);
  if (bytes.includes(0)) {
    throw new Error("binary files are not supported");
  }
  if (bytes.byteLength > 2_000_000) {
    throw new Error("file exceeds the 2 MB read limit");
  }

  const fullContent = bytes.toString("utf8");
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
  } = {}
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  if (query.length === 0 || query.length > 1_000) {
    throw new Error("search query must contain 1 to 1000 characters");
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const inventory = await listRepositoryFiles(repositoryRoot, { limit: 2_000 });
  const needle = options.caseSensitive === true ? query : query.toLocaleLowerCase("en-US");
  const matches: SearchMatch[] = [];

  for (const path of inventory.files) {
    let result: ReadRepositoryFileResult;
    try {
      result = await readRepositoryFile(repositoryRoot, path, { lineCount: 1_000 });
    } catch {
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

export async function getGitStatus(repositoryRoot: string): Promise<{
  content: string;
  truncated: boolean;
}> {
  return bounded(await git(repositoryRoot, ["status", "--short", "--branch"]));
}

export async function getGitDiff(
  repositoryRoot: string,
  relativePath?: string
): Promise<{ content: string; truncated: boolean }> {
  const args = ["diff", "--no-ext-diff", "--no-textconv"];
  if (relativePath !== undefined) {
    args.push("--", assertPublicPath(relativePath));
  }
  return bounded(await git(repositoryRoot, args));
}
