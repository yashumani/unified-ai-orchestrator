import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixtureWorkflowPath = resolve(".github/workflows/fixture-ci.yml");
const releaseWorkflowPath = resolve(".github/workflows/local-production-release.yml");

function actionUses(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
}

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
    const packageJob = workflow.slice(
      workflow.indexOf("  package:"),
      workflow.indexOf("  publish-release:")
    );
    const verify = packageJob.indexOf("npm run verify");
    const audit = packageJob.indexOf("check-npm-audit.mjs");
    const pack = packageJob.indexOf("New-ReleaseArtifact.ps1");
    const controllerPack = packageJob.indexOf("New-RecoveryControllerArtifact.ps1");
    const secondAppPack = packageJob.lastIndexOf("New-ReleaseArtifact.ps1");
    const secondControllerPack = packageJob.lastIndexOf("New-RecoveryControllerArtifact.ps1");
    const determinismGate = packageJob.indexOf("Release artifact creation is not deterministic");
    const upload = packageJob.indexOf("actions/upload-artifact@");
    expect(verify).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(verify);
    expect(workflow).toContain('--commit "${GITHUB_SHA}"');
    expect(pack).toBeGreaterThan(audit);
    expect(controllerPack).toBeGreaterThan(pack);
    expect(workflow.match(/New-ReleaseArtifact\.ps1/gu)).toHaveLength(2);
    expect(workflow.match(/New-RecoveryControllerArtifact\.ps1/gu)).toHaveLength(2);
    expect(determinismGate).toBeGreaterThan(secondAppPack);
    expect(determinismGate).toBeGreaterThan(secondControllerPack);
    expect(workflow).toContain(".zip.sha256");
    expect(upload).toBeGreaterThan(determinismGate);
    expect(workflow).toContain("Publish immutable GitHub Release");
    expect(workflow).toContain("contents: write");
    expect(workflow.match(/name: local-production/gu)).toHaveLength(3);
    expect(workflow).toContain("GH_REPO: ${{ github.repository }}");
    expect(workflow).toContain('tag="local-${RELEASE_SHA}"');
    expect(workflow).toContain('expected_upload_base="https://uploads.github.com/repos/${GH_REPO}/releases/${release_id}/assets"');
    expect(workflow).toContain('api --method PATCH "repos/${GH_REPO}/releases/${release_id}"');
    expect(workflow).toContain("curl --fail-with-body");
    expect(workflow).toContain('test "${asset_state}" = "starter"');
    expect(workflow).toContain('api --method DELETE "repos/${GH_REPO}/releases/assets/${asset_id}"');
    const createTag = workflow.indexOf('api --method POST "repos/${GH_REPO}/git/refs"');
    const publishRelease = workflow.indexOf('api --method PATCH "repos/${GH_REPO}/releases/${release_id}"');
    expect(createTag).toBeGreaterThan(0);
    expect(createTag).toBeLessThan(publishRelease);
    expect(workflow).toContain('git/matching-refs/tags/${tag}');
    expect(workflow).toContain('api --method POST "repos/${GH_REPO}/releases"');
    expect(workflow).toContain("-F draft=true");
    expect(workflow).toContain('release_id="$(jq -r \'.id // empty\' <<<"${release_json}")"');
    expect(workflow).not.toContain("gh release ");
    expect(workflow.match(/for attempt in \{1\.\.10\}/gu)).toHaveLength(4);
    expect(workflow).toContain(".immutable // false");
    expect(workflow).toContain("repos/${GH_REPO}/immutable-releases");
    expect(workflow.indexOf("repos/${GH_REPO}/immutable-releases")).toBeLessThan(
      workflow.indexOf('api --method POST "repos/${GH_REPO}/releases"')
    );
    expect(workflow).toContain('test "$(jq -r .draft <<<"${final_release_json}")" = "false"');
    expect(workflow).toContain('test "${tag_sha}" = "${RELEASE_SHA}"');
    expect(workflow).toContain("cmp --silent");
    expect(workflow).toContain('test "${#assets[@]}" -eq 5');
    expect(workflow).not.toContain("--clobber");
  });

  it("qualifies packaging from an external working directory without stale dist payloads", async () => {
    const workflow = await readFile(fixtureWorkflowPath, "utf8");
    expect(workflow).toContain(
      '$staleMarkerRelative = "apps/api/dist/stale-release-marker.txt"'
    );
    expect(workflow).toContain(
      "Push-Location -LiteralPath $env:RUNNER_TEMP"
    );
    expect(workflow).toContain(
      '& (Join-Path $env:GITHUB_WORKSPACE "scripts/release/New-ReleaseArtifact.ps1")'
    );
    expect(workflow).toContain(
      "$_.FullName -ceq $staleMarkerRelative"
    );
    expect(workflow).toContain(
      "Release archive retained a stale generated output."
    );
  });

  it("deploys only main to the guarded local Windows environment", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("- self-hosted\n      - Windows\n      - X64\n      - unified-ai-orchestrator");
    expect(workflow).toContain("name: local-production");
    expect(workflow).toContain("timeout-minutes: 180");
    expect(workflow).toContain("Test-DeploymentHardening.ps1");
    expect(workflow).toContain("Install-PinnedNodeRuntime.ps1");
    const deployJob = workflow.slice(
      workflow.indexOf("  deploy:"),
      workflow.indexOf("  rollback:")
    );
    expect(deployJob).not.toContain("actions/setup-node");
    const checkout = deployJob.indexOf("actions/checkout@");
    const firstDeploymentScript = deployJob.indexOf("./scripts/deployment/");
    const nodeInstaller = deployJob.indexOf("Install-PinnedNodeRuntime.ps1");
    const hardening = deployJob.indexOf("Test-DeploymentHardening.ps1");
    const artifactDownload = deployJob.indexOf("actions/download-artifact@");
    const canonicalSync = deployJob.indexOf("Sync-CanonicalMain.ps1");
    expect(checkout).toBeGreaterThan(0);
    expect(deployJob.slice(firstDeploymentScript, firstDeploymentScript + 120)).toContain(
      "Install-PinnedNodeRuntime.ps1"
    );
    expect(nodeInstaller).toBeGreaterThan(checkout);
    expect(hardening).toBeGreaterThan(nodeInstaller);
    expect(artifactDownload).toBeGreaterThan(hardening);
    expect(canonicalSync).toBeGreaterThan(artifactDownload);
    expect(workflow).toContain("Sync-CanonicalMain.ps1");
    expect(workflow).toContain("Install-RecoveryControllerArtifact.ps1");
    expect(workflow).toContain("Install-LocalProductionTask.ps1");
    expect(workflow).toContain("Deploy-LocalRelease.ps1");
    const controllerActivation = deployJob.indexOf("Install-LocalProductionTask.ps1");
    const deployInvocation = deployJob.indexOf("Deploy-LocalRelease.ps1");
    expect(controllerActivation).toBeGreaterThan(canonicalSync);
    expect(deployInvocation).toBeGreaterThan(controllerActivation);
    expect(deployJob.slice(deployInvocation)).not.toContain("Install-LocalProductionTask.ps1");
    expect(deployJob.slice(deployInvocation)).not.toContain("Test-LocalRelease.ps1");
    expect(deployJob.slice(deployInvocation)).not.toContain("Test-LocalAiRuntime.ps1");
    expect(workflow).toContain("http://127.0.0.1:8790/api/ready");
  });

  it("uses only the installed last-known-good controller for exact-SHA rollback", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");
    const rollbackJob = workflow.slice(workflow.indexOf("  rollback:"));
    expect(workflow).toContain("rollback_sha:");
    expect(rollbackJob).toContain("inputs.operation == 'rollback'");
    expect(rollbackJob).toContain("last-known-good-controller.json");
    expect(rollbackJob).toContain("controller-manifest.json");
    expect(rollbackJob).toContain("Get-FileHash");
    expect(rollbackJob).toContain('Join-Path $controllerRoot "Rollback-LocalRelease.ps1"');
    expect(rollbackJob).not.toContain('Join-Path $controllerRoot "Test-LocalRelease.ps1"');
    expect(rollbackJob).toContain('"Test-LocalAiRuntime.ps1"');
    expect(rollbackJob).toContain("-ExpectedPreviousSha $expectedSha");
    expect(rollbackJob).not.toContain("actions/checkout");
    expect(rollbackJob).not.toContain("./scripts/");
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
    expect(actionUses(workflow)).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
    ]);
    for (const use of actionUses(workflow)) {
      expect(use).toMatch(/@[0-9a-f]{40}$/u);
    }
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
    expect(workflow.match(/\$\{\{ secrets\.[A-Z0-9_]+ \}\}/gu)).toEqual([
      "${{ secrets.REPOSITORY_ADMIN_READ_TOKEN }}"
    ]);
    expect(workflow.slice(workflow.indexOf("  deploy:"))).not.toContain("secrets.");
    expect(workflow).not.toContain("AZURE");
    expect(workflow).not.toContain("azure");
    expect(workflow).not.toContain("pages");
  });
});
