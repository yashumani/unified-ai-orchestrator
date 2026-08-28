import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProtectedRepositoryPath,
  normalizeRepositoryRelativePath,
  resolveMutationPath
} from "./path-policy.js";

const temporaryRoots: string[] = [];

async function makeRepositoryRoot(): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "uao-path-policy-"));
  temporaryRoots.push(temporaryRoot);
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(repositoryRoot);
  return repositoryRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("protected repository paths", () => {
  it.each([
    ".env",
    ".env.local",
    "nested/.env.production",
    ".git/config",
    ".local/trust/workspace-grant.json",
    "node_modules/package/index.js",
    "nested/node_modules/package/index.js",
    ".cache/runtime.json",
    ".ollama/models/index.json",
    "model-cache/weights.bin",
    "local-index/catalog.sqlite",
    "package.json",
    "apps/web/package.json",
    "scripts/check-public-boundary.mjs",
    "apps/web/vite.config.ts",
    "packages/contracts/tsconfig.json",
    "apps/web/dist/index.html",
    "data/raw/session.json",
    "sources/private/export.json",
    "sources/chatgpt/conversation.json"
  ])("protects %s", (path) => {
    expect(isProtectedRepositoryPath(path)).toBe(true);
  });

  it.each([".env.example", "src/index.ts", "data/public/example.json"])(
    "keeps public path %s eligible for later policy checks",
    (path) => {
      expect(isProtectedRepositoryPath(path)).toBe(false);
    }
  );
});

describe("mutation path resolution", () => {
  it("resolves a missing target beneath existing repository directories", async () => {
    const repositoryRoot = await makeRepositoryRoot();
    await mkdir(join(repositoryRoot, "src"));

    await expect(resolveMutationPath(repositoryRoot, "src/new-file.ts")).resolves.toBe(
      resolve(repositoryRoot, "src", "new-file.ts")
    );
    expect(normalizeRepositoryRelativePath("src\\new-file.ts")).toBe(
      "src/new-file.ts"
    );
  });

  it.each([
    "../escape.ts",
    "src/../../escape.ts",
    "C:\\outside\\escape.ts",
    "\\\\server\\share\\escape.ts",
    "src//file.ts",
    "src/./file.ts"
  ])("rejects lexical escape or ambiguous path %s", async (path) => {
    const repositoryRoot = await makeRepositoryRoot();
    await expect(resolveMutationPath(repositoryRoot, path)).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:invalid_input|path_escape)$/u)
    });
  });

  it("rejects a protected target", async () => {
    const repositoryRoot = await makeRepositoryRoot();
    await expect(
      resolveMutationPath(repositoryRoot, ".local/trust/workspace-grant.json")
    ).rejects.toMatchObject({ code: "protected_path" });
  });

  it("rejects existing symlink or junction traversal", async (context) => {
    const repositoryRoot = await makeRepositoryRoot();
    const outside = join(repositoryRoot, "..", "outside");
    await mkdir(outside);
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");

    try {
      await symlink(
        outside,
        join(repositoryRoot, "linked"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(
      resolveMutationPath(repositoryRoot, "linked/outside.txt")
    ).rejects.toMatchObject({ code: "symlink_escape" });
  });
});
