import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNpmScript, verificationEnvironment } from "./npm-tool.js";
import { assertPublicPath, assertWritablePublicPath } from "./path-safety.js";
import { getGitDiff, getGitStatus, readRepositoryFile, searchRepository } from "./read-tools.js";
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

  it.each([
    "package.json",
    "apps/web/package.json",
    "scripts/check-public-boundary.mjs",
    "apps/web/vite.config.ts",
    "packages/contracts/tsconfig.json",
    "apps/web/dist/index.html"
  ])("blocks model mutation of command or build path %s", (path) => {
    expect(() => assertWritablePublicPath(path)).toThrow(/protected|operator review/u);
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

  it("omits protected tracked content from status and whole-repository diff", async () => {
    const root = await fixtureRepository();
    await writeFile(join(root, ".env"), "SECRET_VALUE=first\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "-f", ".env"], { windowsHide: true });
    await writeFile(join(root, ".env"), "SECRET_VALUE=must-not-leak\n", "utf8");
    await writeFile(join(root, "README.md"), "public change\n", "utf8");

    const status = await getGitStatus(root);
    const diff = await getGitDiff(root);
    expect(status.content).not.toContain(".env");
    expect(status.content).not.toContain("must-not-leak");
    expect(status.protectedEntriesOmitted).toBe(true);
    expect(status.unstagedCount).toBe(1);
    expect(diff.content).not.toContain(".env");
    expect(diff.content).not.toContain("must-not-leak");
    expect(diff.content).toContain("public change");
  });

  it("does not follow a public-looking junction into a protected directory", async () => {
    const root = await fixtureRepository();
    const protectedDirectory = join(root, ".local", "private");
    await mkdir(protectedDirectory, { recursive: true });
    await writeFile(join(protectedDirectory, "secret.txt"), "must-not-leak", "utf8");
    await symlink(protectedDirectory, join(root, "public-link"), "junction");

    await expect(readRepositoryFile(root, "public-link/secret.txt")).rejects.toThrow(
      /symlink|junction/u
    );
  });

  it("refuses reads of untracked public-looking files and hides their names from status", async () => {
    const root = await fixtureRepository();
    await writeFile(join(root, "credentials-local.json"), "not-for-model", "utf8");

    await expect(
      readRepositoryFile(root, "credentials-local.json")
    ).rejects.toThrow(/tracked public files/u);
    const status = await getGitStatus(root);
    expect(status.content).not.toContain("credentials-local.json");
    expect(status.content).toContain("untracked repository entries omitted");
    expect(status.untrackedEntriesOmitted).toBe(true);
    expect(status.clean).toBe(false);
  });

  it("refuses tracked files containing additional high-confidence credential shapes", async () => {
    const root = await fixtureRepository();
    const accessKey = `${"AK"}${"IA"}${"A".repeat(16)}`;
    await writeFile(join(root, "README.md"), `credential=${accessKey}\n`, "utf8");

    await expect(readRepositoryFile(root, "README.md")).rejects.toThrow(
      /credential-shaped/u
    );
  });

  it("honors cancellation in concrete repository read tools", async () => {
    const root = await fixtureRepository();
    const controller = new AbortController();
    controller.abort();

    await expect(
      searchRepository(root, "repository", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      getGitStatus(root, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns staged and unstaged public diffs", async () => {
    const root = await fixtureRepository();
    await writeFile(join(root, "README.md"), "staged change\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "README.md"], {
      windowsHide: true
    });
    await writeFile(join(root, "README.md"), "unstaged change\n", "utf8");

    const diff = await getGitDiff(root);
    const status = await getGitStatus(root);
    expect(diff.content).toContain("staged change");
    expect(diff.content).toContain("unstaged change");
    expect(status).toMatchObject({
      clean: false,
      stagedCount: 1,
      unstagedCount: 1,
      conflictCount: 0,
      entries: ['staged and unstaged: "README.md"']
    });
    expect(status.content).toContain(
      "Public tracked changes: 1 staged, 1 unstaged, 0 conflicted."
    );
  });
});

describe("fixed verification command boundary", () => {
  it("omits credential environment values and ignores mutable package scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "unified-verification-tool-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          "check:public-boundary":
            "node -e \"require('node:fs').writeFileSync('package-script-ran','yes')\""
        }
      }),
      "utf8"
    );
    await writeFile(
      join(root, "scripts", "check-public-boundary.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync('seen-env.txt', process.env.TEST_PHASE1_SECRET ?? 'missing');\n",
      "utf8"
    );

    process.env.TEST_PHASE1_SECRET = "must-not-reach-child";
    try {
      const receipt = await runNpmScript(root, "check:public-boundary");
      expect(receipt).not.toHaveProperty("stdout");
      expect(receipt).not.toHaveProperty("stderr");
      expect(await readFile(join(root, "seen-env.txt"), "utf8")).toBe("missing");
      await expect(readFile(join(root, "package-script-ran"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      delete process.env.TEST_PHASE1_SECRET;
    }
  });

  it("builds a credential-free child environment", () => {
    const environment = verificationEnvironment({
      PATH: "C:\\Tools",
      GH_TOKEN: "secret",
      DATABASE_URL: "secret"
    });
    expect(environment.PATH).toBe("C:\\Tools");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
    expect(environment.CI).toBe("1");
  });
});

describe("repository tool registry", () => {
  it("preserves an allowed write decision without returning the write payload", async () => {
    const root = await fixtureRepository();
    const decision = {
      allowed: true as const,
      code: "allowed" as const,
      reason: "Permanent repository trust authorizes this guarded write.",
      checkedAt: "2026-08-28T05:00:00.000Z"
    };
    const registry = new RepositoryToolRegistry({
      repositoryRoot: root,
      authorizeMutation: async () => decision
    });
    const content = "sensitive model-supplied write payload";

    const result = await registry.execute({
      callId: "call-allowed-write",
      toolName: "repository.write_file",
      arguments: { path: "generated.txt", content }
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: "generated.txt",
        policy: decision
      }
    });
    expect(JSON.stringify(result)).not.toContain(content);
    expect(await readFile(join(root, "generated.txt"), "utf8")).toBe(content);
  });

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

  it.each([
    ["shell.exec", {}, "tool_not_allowed"],
    ["malformed.tool_call", { malformed: true }, "invalid_input"],
    ["repository.read_file", "README.md", "invalid_input"]
  ])("returns rejected result for untrusted tool request %s", async (toolName, argumentsValue, code) => {
    const root = await fixtureRepository();
    const authorizeMutation = vi.fn();
    const registry = new RepositoryToolRegistry({
      repositoryRoot: root,
      authorizeMutation
    });
    const result = await registry.execute({
      callId: "call-rejected",
      toolName,
      arguments: argumentsValue
    });
    expect(result).toMatchObject({
      ok: false,
      data: { policy: { allowed: false, code } }
    });
    expect(authorizeMutation).not.toHaveBeenCalled();
  });
});
