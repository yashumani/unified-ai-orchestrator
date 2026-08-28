import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const PROTECTED_PREFIXES = [
  ".git",
  ".local",
  "node_modules",
  "data/raw",
  "sources/private",
  "sources/chatgpt",
  ".cache",
  ".ollama",
  "model-cache",
  "local-index"
] as const;

export class RepositoryPathError extends Error {
  readonly code: "path_escape" | "protected_path" | "symlink_escape";

  constructor(
    code: "path_escape" | "protected_path" | "symlink_escape",
    message: string
  ) {
    super(message);
    this.name = "RepositoryPathError";
    this.code = code;
  }
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

export function normalizeRepositoryPath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized)
  ) {
    throw new RepositoryPathError("path_escape", "expected a repository-relative path");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new RepositoryPathError("path_escape", "path traversal is not allowed");
  }

  return normalized;
}

export function assertPublicPath(relativePath: string): string {
  const normalized = normalizeRepositoryPath(relativePath);
  const lower = normalized.toLowerCase();
  const baseName = lower.split("/").at(-1) ?? "";

  if (baseName !== ".env.example" && /^\.env(?:\.|$)/u.test(baseName)) {
    throw new RepositoryPathError("protected_path", "environment files are protected");
  }

  if (
    PROTECTED_PREFIXES.some(
      (prefix) => lower === prefix || lower.startsWith(`${prefix}/`)
    ) ||
    /(?:^|\/)[^/]*\.raw-chat\.json$/iu.test(normalized) ||
    /(?:^|\/)[^/]*(?:transcript|session)[^/]*\.jsonl$/iu.test(normalized) ||
    /(?:^|\/)[^/]*\.sqlite3?$/iu.test(normalized)
  ) {
    throw new RepositoryPathError("protected_path", "the requested path is protected");
  }

  return normalized;
}

async function nearestExistingPath(candidate: string, root: string): Promise<string> {
  let current = candidate;
  while (isContained(root, current)) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return root;
}

export async function resolveSafeRepositoryPath(
  repositoryRoot: string,
  relativePath: string
): Promise<{ repositoryRoot: string; relativePath: string; absolutePath: string }> {
  const canonicalRoot = await realpath(resolve(repositoryRoot));
  const normalized = assertPublicPath(relativePath);
  const candidate = resolve(canonicalRoot, ...normalized.split("/"));
  if (!isContained(canonicalRoot, candidate)) {
    throw new RepositoryPathError("path_escape", "path escapes the repository root");
  }

  const existing = await nearestExistingPath(candidate, canonicalRoot);
  const canonicalExisting = await realpath(existing);
  if (!isContained(canonicalRoot, canonicalExisting)) {
    throw new RepositoryPathError(
      "symlink_escape",
      "resolved path escapes through a symlink or junction"
    );
  }

  return {
    repositoryRoot: canonicalRoot,
    relativePath: normalized,
    absolutePath: candidate
  };
}
