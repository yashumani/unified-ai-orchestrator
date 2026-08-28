import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { resolveSafeRepositoryPath } from "./path-safety.js";

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function existingHash(path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = resolve(parent, `.${basename(path)}.${randomUUID()}.temporary`);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface WriteRepositoryFileInput {
  path: string;
  content: string;
  expectedSha256?: string | undefined;
}

export async function writeRepositoryFile(
  repositoryRoot: string,
  input: WriteRepositoryFileInput
): Promise<{ path: string; previousSha256?: string; contentSha256: string }> {
  if (Buffer.byteLength(input.content, "utf8") > 1_000_000) {
    throw new Error("write content exceeds the 1 MB limit");
  }
  const safe = await resolveSafeRepositoryPath(repositoryRoot, input.path);
  const previousSha256 = await existingHash(safe.absolutePath);

  if (previousSha256 === undefined && input.expectedSha256 !== undefined) {
    throw new Error("precondition failed: target does not exist");
  }
  if (previousSha256 !== undefined && input.expectedSha256 === undefined) {
    throw new Error("precondition failed: expectedSha256 is required for replacement");
  }
  if (previousSha256 !== undefined && previousSha256 !== input.expectedSha256) {
    throw new Error("precondition failed: target content changed");
  }

  await atomicWrite(safe.absolutePath, input.content);
  const result: { path: string; previousSha256?: string; contentSha256: string } = {
    path: safe.relativePath,
    contentSha256: sha256(input.content)
  };
  if (previousSha256 !== undefined) {
    result.previousSha256 = previousSha256;
  }
  return result;
}

export interface ReplaceRepositoryTextInput {
  path: string;
  search: string;
  replacement: string;
  expectedOccurrences: number;
  expectedSha256: string;
}

export async function replaceRepositoryText(
  repositoryRoot: string,
  input: ReplaceRepositoryTextInput
): Promise<{ path: string; previousSha256: string; contentSha256: string; replacements: number }> {
  if (input.search.length === 0) {
    throw new Error("replacement search text cannot be empty");
  }
  if (!Number.isInteger(input.expectedOccurrences) || input.expectedOccurrences < 1) {
    throw new Error("expectedOccurrences must be a positive integer");
  }
  const safe = await resolveSafeRepositoryPath(repositoryRoot, input.path);
  const current = await readFile(safe.absolutePath, "utf8");
  const currentSha256 = sha256(current);
  if (currentSha256 !== input.expectedSha256) {
    throw new Error("precondition failed: target content changed");
  }
  const occurrences = current.split(input.search).length - 1;
  if (occurrences !== input.expectedOccurrences) {
    throw new Error(
      `precondition failed: expected ${input.expectedOccurrences} occurrences, found ${occurrences}`
    );
  }
  const content = current.replaceAll(input.search, input.replacement);
  await atomicWrite(safe.absolutePath, content);
  return {
    path: safe.relativePath,
    previousSha256: currentSha256,
    contentSha256: sha256(content),
    replacements: occurrences
  };
}

export async function createRepositoryDirectory(
  repositoryRoot: string,
  relativePath: string
): Promise<{ path: string }> {
  const safe = await resolveSafeRepositoryPath(repositoryRoot, relativePath);
  await mkdir(safe.absolutePath, { recursive: true });
  const verified = await resolveSafeRepositoryPath(repositoryRoot, relativePath);
  return { path: verified.relativePath };
}
