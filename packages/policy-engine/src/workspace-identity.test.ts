import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  fingerprintGitOrigin,
  isProtectedBranch,
  matchesDevelopmentBranch,
  normalizeGitOrigin,
  resolveWorkspaceIdentity,
  WorkspaceIdentityError
} from "./workspace-identity.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
}

async function makeGitRepository(branch = "feature/policy-test"): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "uao-policy-identity-"));
  temporaryRoots.push(temporaryRoot);
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, "init", "--quiet");
  await git(repositoryRoot, "config", "user.name", "Unified AI test fixture");
  await git(
    repositoryRoot,
    "config",
    "user.email",
    "unified-ai-test-fixture@example.invalid"
  );
  await git(repositoryRoot, "switch", "--quiet", "--create", branch);
  await git(
    repositoryRoot,
    "remote",
    "add",
    "origin",
    "https://example.test/yashu/unified-ai-orchestrator.git"
  );
  return repositoryRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("Git origin normalization", () => {
  it("removes credentials, query values, fragments, and the Git suffix", () => {
    expect(
      normalizeGitOrigin(
        "https://token:secret@GitHub.COM/yashumani/project.git?access=secret#fragment"
      )
    ).toBe("https://github.com/yashumani/project");
  });

  it("normalizes SCP and URL-style SSH remotes to the same fingerprint", () => {
    const scp = "git@github.com:yashumani/project.git";
    const ssh = "ssh://git@GITHUB.com/yashumani/project.git";

    expect(normalizeGitOrigin(scp)).toBe("ssh://github.com/yashumani/project");
    expect(normalizeGitOrigin(ssh)).toBe("ssh://github.com/yashumani/project");
    expect(fingerprintGitOrigin(scp)).toBe(fingerprintGitOrigin(ssh));
  });

  it.each([
    "",
    "../local-repository",
    "C:\\local-repository",
    "file:///tmp/local-repository",
    "ftp://example.test/project.git"
  ])("fails closed for an ambiguous or disallowed origin: %s", (origin) => {
    expect(() => normalizeGitOrigin(origin)).toThrow(WorkspaceIdentityError);
  });
});

describe("branch policy", () => {
  it.each(["dev", "dev-local", "feature/a", "codex/a", "codex_ys/a", "backup/a"])(
    "allows the documented branch class %s",
    (branch) => {
      expect(matchesDevelopmentBranch(branch)).toBe(true);
    }
  );

  it.each(["main", "master", "release/1.0"])(
    "always protects %s",
    (branch) => {
      expect(isProtectedBranch(branch)).toBe(true);
      expect(matchesDevelopmentBranch(branch)).toBe(false);
    }
  );

  it.each(["release", "develop", "feature/", "codex", "hotfix/a", ""])(
    "does not implicitly trust undocumented branch %s",
    (branch) => {
      expect(matchesDevelopmentBranch(branch)).toBe(false);
    }
  );
});

describe("workspace identity", () => {
  it("resolves the canonical Git root, sanitized origin, branch, and fingerprint", async () => {
    const repositoryRoot = await makeGitRepository();
    const identity = await resolveWorkspaceIdentity(repositoryRoot);

    expect(identity.repositoryRoot).toBe(await realpath(repositoryRoot));
    expect(identity.origin).toBe(
      "https://example.test/yashu/unified-ai-orchestrator"
    );
    expect(identity.originSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(identity.branch).toBe("feature/policy-test");
    expect(identity.protectedBranch).toBe(false);
  });

  it("rejects a configured subdirectory instead of silently widening scope", async () => {
    const repositoryRoot = await makeGitRepository();
    const subdirectory = join(repositoryRoot, "nested");
    await mkdir(subdirectory);

    await expect(resolveWorkspaceIdentity(subdirectory)).rejects.toMatchObject({
      code: "repository_mismatch"
    });
  });

  it("rejects detached HEAD", async () => {
    const repositoryRoot = await makeGitRepository();
    await git(repositoryRoot, "commit", "--allow-empty", "--message", "fixture", "--quiet");
    await git(repositoryRoot, "checkout", "--detach", "--quiet");

    await expect(resolveWorkspaceIdentity(repositoryRoot)).rejects.toMatchObject({
      code: "branch_not_allowed"
    });
  });
});
