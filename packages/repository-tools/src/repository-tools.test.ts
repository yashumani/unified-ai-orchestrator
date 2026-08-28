import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { assertPublicPath } from "./path-safety.js";
import { readRepositoryFile } from "./read-tools.js";
import { RepositoryToolRegistry } from "./tool-registry.js";
import { writeRepositoryFile } from "./write-tools.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unified-repository-tools-"));
  temporaryRoots.push(root);
  await execFileAsync("git", ["init", root], { windowsHide: true });
  await writeFile(join(root, "README.md"), "hello repository\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "README.md"], { windowsHide: true });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository path boundary", () => {
  it("blocks credentials and traversal while allowing the public example", () => {
    expect(() => assertPublicPath(".env")).toThrow(/protected/u);
    expect(() => assertPublicPath("../outside.txt")).toThrow(/traversal/u);
    expect(assertPublicPath(".env.example")).toBe(".env.example");
  });
});

describe("repository reads and writes", () => {
  it("returns line-bounded content and a full-file hash", async () => {
    const root = await fixtureRepository();
    const result = await readRepositoryFile(root, "README.md", { lineCount: 1 });
    expect(result.content).toBe("hello repository");
    expect(result.contentSha256).toBe(
      createHash("sha256").update("hello repository\n").digest("hex")
    );
  });

  it("requires a matching content hash to replace an existing file", async () => {
    const root = await fixtureRepository();
    await expect(
      writeRepositoryFile(root, { path: "README.md", content: "changed\n" })
    ).rejects.toThrow(/expectedSha256/u);

    const expectedSha256 = createHash("sha256")
      .update("hello repository\n")
      .digest("hex");
    await writeRepositoryFile(root, {
      path: "README.md",
      content: "changed\n",
      expectedSha256
    });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("changed\n");
  });
});

describe("repository tool registry", () => {
  it("does not invoke a blocked mutation", async () => {
    const root = await fixtureRepository();
    const registry = new RepositoryToolRegistry({
      repositoryRoot: root,
      authorizeMutation: async () => ({
        allowed: false,
        code: "workspace_untrusted",
        reason: "grant missing",
        checkedAt: "2026-08-28T05:00:00.000Z"
      })
    });
    const result = await registry.execute({
      callId: "call-1",
      toolName: "repository.write_file",
      arguments: { path: "new.txt", content: "blocked" }
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("workspace_untrusted");
    await expect(readFile(join(root, "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
