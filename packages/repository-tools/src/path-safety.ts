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

const SENSITIVE_FILE_NAMES = new Set([
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "credentials.yaml",
  "credentials.yml",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "id_rsa",
  "id_ed25519"
]);

const COMMAND_CONFIGURATION_FILE = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^.]+)?\.json|vite\.config\.[^.]+|vitest\.config\.[^.]+)$/u;
const PRIVATE_KEY_FILE = /\.(?:key|pem|p12|pfx)$/u;

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
  const segments = lower.split("/");
  const baseName = segments.at(-1) ?? "";

  if (baseName !== ".env.example" && /^\.env(?:\.|$)/u.test(baseName)) {
    throw new RepositoryPathError("protected_path", "environment files are protected");
  }

  if (
    PROTECTED_PREFIXES.some(
      (prefix) => lower === prefix || lower.startsWith(`${prefix}/`)
    ) ||
    segments.some((segment) => segment === "dist" || segment === "coverage") ||
    SENSITIVE_FILE_NAMES.has(baseName) ||
    PRIVATE_KEY_FILE.test(baseName) ||
    /(?:^|\/)[^/]*\.raw-chat\.json$/iu.test(normalized) ||
    /(?:^|\/)[^/]*(?:transcript|session)[^/]*\.jsonl$/iu.test(normalized) ||
    /(?:^|\/)[^/]*\.sqlite3?$/iu.test(normalized)
  ) {
    throw new RepositoryPathError("protected_path", "the requested path is protected");
  }

  return normalized;
}

export function assertWritablePublicPath(relativePath: string): string {
  const normalized = assertPublicPath(relativePath);
  const lower = normalized.toLowerCase();
  const baseName = lower.split("/").at(-1) ?? "";
  if (
    lower === "scripts" ||
    lower.startsWith("scripts/") ||
    lower === ".github/workflows" ||
    lower.startsWith(".github/workflows/") ||
    COMMAND_CONFIGURATION_FILE.test(baseName)
  ) {
    throw new RepositoryPathError(
      "protected_path",
      "command and build configuration files require direct operator review"
    );
  }
  return normalized;
}

export async function resolveSafeRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
  options: { mode?: "read" | "write" } = {}
): Promise<{ repositoryRoot: string; relativePath: string; absolutePath: string }> {
  const canonicalRoot = await realpath(resolve(repositoryRoot));
  const normalized =
    options.mode === "write"
      ? assertWritablePublicPath(relativePath)
      : assertPublicPath(relativePath);
  const segments = normalized.split("/");
  const candidate = resolve(canonicalRoot, ...segments);
  if (!isContained(canonicalRoot, candidate)) {
    throw new RepositoryPathError("path_escape", "path escapes the repository root");
  }

  let current = canonicalRoot;
  let absolutePath = candidate;
  for (const [index, segment] of segments.entries()) {
    const next = resolve(current, segment);
    let status;
    try {
      status = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        absolutePath = resolve(current, ...segments.slice(index));
        break;
      }
      throw error;
    }

    if (status.isSymbolicLink()) {
      throw new RepositoryPathError(
        "symlink_escape",
        "repository tools cannot traverse a symlink or junction"
      );
    }
    const canonicalExisting = await realpath(next);
    if (!isContained(canonicalRoot, canonicalExisting)) {
      throw new RepositoryPathError(
        "symlink_escape",
        "resolved path escapes through a symlink or junction"
      );
    }
    if (index < segments.length - 1 && !status.isDirectory()) {
      throw new RepositoryPathError(
        "path_escape",
        "a non-directory component appears before the requested target"
      );
    }
    current = canonicalExisting;
    absolutePath = canonicalExisting;
  }

  return {
    repositoryRoot: canonicalRoot,
    relativePath: normalized,
    absolutePath
  };
}
