import { lstat, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import {
  canonicalPathKey,
  isPathInsideOrEqual
} from "./workspace-identity.js";

export type PathPolicyErrorCode =
  | "invalid_input"
  | "path_escape"
  | "protected_path"
  | "symlink_escape";

export class PathPolicyError extends Error {
  public readonly code: PathPolicyErrorCode;

  public constructor(code: PathPolicyErrorCode, message: string) {
    super(message);
    this.name = "PathPolicyError";
    this.code = code;
  }
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTER = /[:*?"<>|]/u;
const COMMAND_CONFIGURATION_FILE = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^.]+)?\.json|vite\.config\.[^.]+|vitest\.config\.[^.]+)$/u;

function normalizedSegments(repositoryRelativePath: string): string[] {
  const value = repositoryRelativePath.trim();
  if (
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("//")
  ) {
    throw new PathPolicyError(
      "invalid_input",
      "Repository path must be a non-empty relative text path."
    );
  }

  const segments = value.replace(/\\/gu, "/").split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED_NAME.test(segment) ||
        WINDOWS_FORBIDDEN_CHARACTER.test(segment)
    )
  ) {
    throw new PathPolicyError(
      "path_escape",
      "Repository path contains an unsafe component."
    );
  }

  return segments;
}

export function normalizeRepositoryRelativePath(
  repositoryRelativePath: string
): string {
  return normalizedSegments(repositoryRelativePath).join("/");
}

export function isProtectedRepositoryPath(
  repositoryRelativePath: string
): boolean {
  const segments = normalizedSegments(repositoryRelativePath).map((segment) =>
    segment.toLowerCase()
  );
  const normalized = segments.join("/");

  if (
    segments.some(
      (segment) =>
        segment === ".git" ||
        segment === ".local" ||
        segment === "node_modules" ||
        segment === ".cache" ||
        segment === ".ollama" ||
        segment === "model-cache" ||
        segment === "local-index"
    )
  ) {
    return true;
  }

  const baseName = segments.at(-1) ?? "";
  if (
    segments.some((segment) => segment === "dist" || segment === "coverage") ||
    normalized === "scripts" ||
    normalized.startsWith("scripts/") ||
    normalized === ".github/workflows" ||
    normalized.startsWith(".github/workflows/") ||
    COMMAND_CONFIGURATION_FILE.test(baseName)
  ) {
    return true;
  }

  if (
    segments.some(
      (segment) =>
        segment === ".env" ||
        (segment.startsWith(".env.") && segment !== ".env.example")
    )
  ) {
    return true;
  }

  return (
    normalized === "data/raw" ||
    normalized.startsWith("data/raw/") ||
    normalized === "sources/private" ||
    normalized.startsWith("sources/private/") ||
    normalized === "sources/chatgpt" ||
    normalized.startsWith("sources/chatgpt/")
  );
}

function isInsideLexically(root: string, target: string): boolean {
  const difference = relative(root, target);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

/**
 * Validates the lexical boundary and every existing component. Any symlink or
 * junction component is rejected, even if it currently resolves back inside
 * the repository, so later replacement cannot redirect a trusted mutation.
 */
export async function resolveMutationPath(
  repositoryRoot: string,
  repositoryRelativePath: string
): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(repositoryRoot));
  } catch {
    throw new PathPolicyError(
      "path_escape",
      "Canonical repository root is unavailable."
    );
  }

  const segments = normalizedSegments(repositoryRelativePath);
  const normalized = segments.join("/");
  if (isProtectedRepositoryPath(normalized)) {
    throw new PathPolicyError(
      "protected_path",
      "Repository path is protected from model-driven mutation."
    );
  }

  const lexicalTarget = resolve(canonicalRoot, ...segments);
  if (!isInsideLexically(canonicalRoot, lexicalTarget)) {
    throw new PathPolicyError(
      "path_escape",
      "Repository path escapes the canonical repository root."
    );
  }

  let current = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    const next = join(current, segment);
    let status;
    try {
      status = await lstat(next);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        const remaining = segments.slice(index);
        const unresolvedTarget = resolve(current, ...remaining);
        if (!isInsideLexically(canonicalRoot, unresolvedTarget)) {
          throw new PathPolicyError(
            "path_escape",
            "Repository path escapes the canonical repository root."
          );
        }
        return unresolvedTarget;
      }
      throw new PathPolicyError(
        "path_escape",
        "Repository path could not be inspected safely."
      );
    }

    if (status.isSymbolicLink()) {
      throw new PathPolicyError(
        "symlink_escape",
        "Repository mutation cannot traverse a symlink or junction."
      );
    }

    let resolvedExistingComponent: string;
    try {
      resolvedExistingComponent = await realpath(next);
    } catch {
      throw new PathPolicyError(
        "path_escape",
        "An existing path component cannot be resolved safely."
      );
    }

    if (!isPathInsideOrEqual(canonicalRoot, resolvedExistingComponent)) {
      throw new PathPolicyError(
        "symlink_escape",
        "An existing path component resolves outside the repository."
      );
    }

    if (index < segments.length - 1 && !status.isDirectory()) {
      throw new PathPolicyError(
        "invalid_input",
        "A non-directory component appears before the mutation target."
      );
    }
    current = resolvedExistingComponent;
  }

  if (
    !isPathInsideOrEqual(canonicalRoot, current) ||
    canonicalPathKey(current) === canonicalPathKey(canonicalRoot)
  ) {
    throw new PathPolicyError(
      "path_escape",
      "Repository mutation target is outside the writable boundary."
    );
  }

  return current;
}
