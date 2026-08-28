import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyDeniedError, PolicyEngine, isMutationTool } from "./policy-engine.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const FIXED_NOW = new Date("2026-08-28T12:00:00.000Z");

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true
  });
}

async function makeEngine(): Promise<{
  engine: PolicyEngine;
  repositoryRoot: string;
}> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "uao-policy-engine-"));
  temporaryRoots.push(temporaryRoot);
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, "init", "--quiet");
  await git(
    repositoryRoot,
    "switch",
    "--quiet",
    "--create",
    "feature/policy-test"
  );
  await git(
    repositoryRoot,
    "remote",
    "add",
    "origin",
    "https://example.test/yashu/unified-ai-orchestrator.git"
  );
  await writeFile(join(repositoryRoot, "package.json"), "{}\n", "utf8");

  return {
    repositoryRoot,
    engine: new PolicyEngine({
      repositoryRoot,
      now: () => FIXED_NOW
    })
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("persistent workspace trust", () => {
  it("persists an active permanent grant and reads it after reconstruction", async () => {
    const { engine, repositoryRoot } = await makeEngine();
    const granted = await engine.grantWorkspaceTrust();

    expect(granted.trusted).toBe(true);
    expect(granted.grant).toMatchObject({
      permanent: true,
      grantedAt: FIXED_NOW.toISOString(),
      branchPatterns: [
        "dev",
        "dev-*",
        "feature/*",
        "codex/*",
        "codex_ys/*",
        "backup/*"
      ]
    });
    expect(engine.configuredGrantPath).toBe(
      join(repositoryRoot, ".local", "trust", "workspace-grant.json")
    );

    const reconstructed = new PolicyEngine({
      repositoryRoot,
      now: () => FIXED_NOW
    });
    await expect(reconstructed.getTrustState()).resolves.toMatchObject({
      trusted: true,
      reason: expect.stringContaining("matches current Git identity")
    });
  });

  it("persists revocation and blocks the next mutation", async () => {
    const { engine, repositoryRoot } = await makeEngine();
    await engine.grantWorkspaceTrust();
    const revoked = await engine.revokeWorkspaceTrust();

    expect(revoked.trusted).toBe(false);
    expect(revoked.grant).toBeNull();
    const document = JSON.parse(
      await readFile(engine.configuredGrantPath, "utf8")
    ) as Record<string, unknown>;
    expect(document).toMatchObject({
      status: "revoked",
      revokedAt: FIXED_NOW.toISOString()
    });

    const reconstructed = new PolicyEngine({ repositoryRoot });
    await expect(
      reconstructed.evaluateMutation({
        toolName: "repository.write_file",
        repositoryRelativePath: "src/after-revoke.ts"
      })
    ).resolves.toMatchObject({
      decision: { allowed: false, code: "workspace_untrusted" }
    });
  });

  it("fails closed when the local grant is corrupt", async () => {
    const { engine } = await makeEngine();
    await mkdir(dirname(engine.configuredGrantPath), { recursive: true });
    await writeFile(engine.configuredGrantPath, "{not-json", "utf8");

    await expect(engine.getTrustState()).resolves.toMatchObject({
      trusted: false,
      grant: null,
      reason: expect.stringContaining("unreadable")
    });
  });
});

describe("per-mutation revalidation", () => {
  it("allows a typed write only after a matching persistent grant", async () => {
    const { engine, repositoryRoot } = await makeEngine();
    await engine.grantWorkspaceTrust();

    const authorization = await engine.evaluateMutation({
      toolName: "repository.write_file",
      repositoryRelativePath: "src/new-file.ts"
    });

    expect(authorization.decision).toMatchObject({
      allowed: true,
      code: "allowed"
    });
    expect(authorization.resolvedPath).toBe(join(repositoryRoot, "src", "new-file.ts"));
    expect(authorization.grant).not.toBeNull();
  });

  it("rejects an unknown or read-only tool as a mutation", async () => {
    const { engine } = await makeEngine();
    await engine.grantWorkspaceTrust();

    for (const toolName of ["trust.grant", "repository.read_file"]) {
      await expect(engine.evaluateMutation({ toolName })).resolves.toMatchObject({
        decision: { allowed: false, code: "tool_not_allowed" }
      });
    }
    expect(isMutationTool("trust.grant")).toBe(false);
    expect(isMutationTool("repository.write_file")).toBe(true);
  });

  it.each([
    ".env",
    ".env.local",
    ".git/config",
    ".local/evidence/object.json",
    "node_modules/dependency/index.js",
    "data/raw/export.json",
    "sources/private/session.json",
    "sources/chatgpt/session.json"
  ])("rejects protected path %s", async (path) => {
    const { engine } = await makeEngine();
    await engine.grantWorkspaceTrust();

    await expect(
      engine.evaluateMutation({
        toolName: "repository.write_file",
        repositoryRelativePath: path
      })
    ).resolves.toMatchObject({
      decision: { allowed: false, code: "protected_path" }
    });
  });

  it("rejects path escape", async () => {
    const { engine } = await makeEngine();
    await engine.grantWorkspaceTrust();

    await expect(
      engine.evaluateMutation({
        toolName: "repository.write_file",
        repositoryRelativePath: "../outside.ts"
      })
    ).resolves.toMatchObject({
      decision: { allowed: false, code: "path_escape" }
    });
  });

  it("rechecks the origin fingerprint for every mutation", async () => {
    const { engine, repositoryRoot } = await makeEngine();
    await engine.grantWorkspaceTrust();
    await git(
      repositoryRoot,
      "remote",
      "set-url",
      "origin",
      "https://example.test/attacker/other.git"
    );

    await expect(
      engine.evaluateMutation({
        toolName: "repository.create_directory",
        repositoryRelativePath: "src/new-directory"
      })
    ).resolves.toMatchObject({
      decision: { allowed: false, code: "origin_mismatch" }
    });
  });

  it.each([
    ["main", "protected_branch"],
    ["master", "protected_branch"],
    ["release/1.0", "protected_branch"],
    ["hotfix/unapproved", "branch_not_allowed"]
  ] as const)("rechecks branch %s and returns %s", async (branch, code) => {
    const { engine, repositoryRoot } = await makeEngine();
    await engine.grantWorkspaceTrust();
    await git(repositoryRoot, "switch", "--quiet", "--create", branch);

    await expect(
      engine.evaluateMutation({
        toolName: "repository.create_directory",
        repositoryRelativePath: "src/new-directory"
      })
    ).resolves.toMatchObject({
      decision: { allowed: false, code }
    });
  });

  it("fails a copied grant whose repository root does not match", async () => {
    const { engine } = await makeEngine();
    await engine.grantWorkspaceTrust();
    const document = JSON.parse(
      await readFile(engine.configuredGrantPath, "utf8")
    ) as { grant: { repositoryRoot: string } };
    document.grant.repositoryRoot = dirname(document.grant.repositoryRoot);
    await writeFile(
      engine.configuredGrantPath,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8"
    );

    await expect(
      engine.evaluateMutation({
        toolName: "repository.write_file",
        repositoryRelativePath: "src/new-file.ts"
      })
    ).resolves.toMatchObject({
      decision: { allowed: false, code: "repository_mismatch" }
    });
  });

  it("throws a typed denial from the assertion API", async () => {
    const { engine } = await makeEngine();
    await expect(
      engine.assertMutationAllowed({
        toolName: "repository.write_file",
        repositoryRelativePath: "src/new-file.ts"
      })
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });
});
