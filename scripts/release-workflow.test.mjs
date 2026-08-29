import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixtureWorkflowPath = resolve(".github/workflows/fixture-ci.yml");
const releaseWorkflowPath = resolve(".github/workflows/local-production-release.yml");

describe("local production release workflow contract", () => {
  it("extends public fixture verification to main without removing feature and PR coverage", async () => {
    const workflow = await readFile(fixtureWorkflowPath, "utf8");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain('- "feature/**"');
    expect(workflow).toContain("npm run verify");
  });

  it("verifies, gates, packages, and publishes before deployment", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");
    const verify = workflow.indexOf("npm run verify");
    const audit = workflow.indexOf("check-npm-audit.mjs");
    const pack = workflow.indexOf("New-ReleaseArtifact.ps1");
    const upload = workflow.indexOf("actions/upload-artifact@v7");
    expect(verify).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(verify);
    expect(workflow).toContain('--commit "${GITHUB_SHA}"');
    expect(pack).toBeGreaterThan(audit);
    expect(upload).toBeGreaterThan(pack);
    expect(workflow).toContain("Publish immutable GitHub Release");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("GH_REPO: ${{ github.repository }}");
    expect(workflow).toContain('tag="local-${RELEASE_SHA}"');
    expect(workflow).toContain("gh release download");
    expect(workflow).toContain('git/matching-refs/tags/${tag}');
    expect(workflow).toContain('test "${created_tag_sha}" = "${RELEASE_SHA}"');
    expect(workflow).toContain("cmp --silent");
    expect(workflow).not.toContain("--clobber");
  });

  it("deploys only main to the guarded local Windows environment", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("- self-hosted\n      - Windows\n      - X64\n      - unified-ai-orchestrator");
    expect(workflow).toContain("name: local-production");
    expect(workflow).toContain("Sync-CanonicalMain.ps1");
    expect(workflow).toContain("Deploy-LocalRelease.ps1");
    expect(workflow).toContain("Test-LocalRelease.ps1");
    expect(workflow).toContain("-RequireRepositoryHeadMatch");
    expect(workflow).toContain("http://127.0.0.1:8790/api/ready");
  });

  it("requires an exact requested SHA for one-step rollback", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");
    expect(workflow).toContain("rollback_sha:");
    expect(workflow).toContain("inputs.operation == 'rollback'");
    expect(workflow).toContain("Confirm-RollbackTarget.ps1");
    expect(workflow).toContain("Rollback-LocalRelease.ps1");
    expect(workflow.match(/EXPECTED_ROLLBACK_SHA: \$\{\{ inputs\.rollback_sha \}\}/gu)).toHaveLength(3);
    expect(workflow).toContain("-ExpectedPreviousSha $env:EXPECTED_ROLLBACK_SHA");
    expect(workflow).toContain("-ExpectedSha $env:EXPECTED_ROLLBACK_SHA");
    expect(workflow).not.toContain('-ExpectedSha "${{ inputs.rollback_sha }}"');
  });

  it("uses least privilege and never persists checkout credentials", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");
    expect(workflow).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # actions/checkout@v7"
    );
    expect(workflow).toContain(
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # actions/setup-node@v6"
    );
    expect(workflow).toContain('node-version: "22.23.2"');
    expect(workflow).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # actions/upload-artifact@v7"
    );
    expect(workflow).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # actions/download-artifact@v8"
    );
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(3);
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("AZURE");
    expect(workflow).not.toContain("azure");
    expect(workflow).not.toContain("pages");
  });
});
