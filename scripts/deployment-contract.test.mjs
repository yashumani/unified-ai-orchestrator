import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function deploymentScript(name) {
  return await readFile(resolve("scripts/deployment", name), "utf8");
}

describe("Windows local-production deployment contract", () => {
  it("pins loopback readiness and the reviewed official runner", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    expect(common).toContain('$script:CanonicalHealthUri = "http://127.0.0.1:8790/api/ready"');
    expect(common).toContain('$script:PinnedRunnerVersion = "2.337.0"');
    expect(common).toContain(
      '$script:PinnedRunnerArchiveSha256 = "1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc"'
    );
    expect(common).toContain('RunnerRoot = Join-Path $root "github-runner\\2.337.0"');
    expect(common).toContain('$script:PinnedNodeVersion = "22.23.2"');
    expect(common).toContain(
      '$script:PinnedNodeArchiveSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"'
    );
    expect(common).toContain('NodeRuntimeRoot = Join-Path $root "toolchains\\node-v22.23.2-win-x64"');
  });

  it("installs immutable payloads before atomic activation and exact-SHA readiness", async () => {
    const deploy = await deploymentScript("Deploy-LocalRelease.ps1");
    const validateArchive = deploy.indexOf("Test-ReleaseArchive");
    const moveToFinal = deploy.indexOf("Move-Item -LiteralPath $stagingRoot -Destination $releaseRoot");
    const installDependencies = deploy.indexOf("ci --omit=dev --ignore-scripts");
    const writeRuntimeReceipt = deploy.indexOf("Write-RuntimeDependencyIntegrity");
    const sealRelease = deploy.indexOf("Protect-ReleaseDirectory");
    const activatePointer = deploy.indexOf("-Path $layout.Current");
    const readiness = deploy.indexOf("Wait-ForReleaseHealth");
    expect(validateArchive).toBeGreaterThan(0);
    expect(moveToFinal).toBeGreaterThan(validateArchive);
    expect(installDependencies).toBeGreaterThan(moveToFinal);
    expect(writeRuntimeReceipt).toBeGreaterThan(installDependencies);
    expect(sealRelease).toBeGreaterThan(writeRuntimeReceipt);
    expect(activatePointer).toBeGreaterThan(sealRelease);
    expect(readiness).toBeGreaterThan(activatePointer);
    const setLastKnownGood = deploy.indexOf("Set-LastKnownGoodRecoveryController");
    const localReleaseAcceptance = deploy.indexOf("Test-LocalRelease.ps1");
    const localAiAcceptance = deploy.indexOf("Test-LocalAiRuntime.ps1");
    const removePending = deploy.indexOf(
      "Remove-Item -LiteralPath $layout.Pending",
      localAiAcceptance
    );
    const activationCommitted = deploy.indexOf("$activationCommitted = $true");
    expect(setLastKnownGood).toBeGreaterThan(readiness);
    expect(localReleaseAcceptance).toBeGreaterThan(setLastKnownGood);
    expect(localAiAcceptance).toBeGreaterThan(localReleaseAcceptance);
    expect(removePending).toBeGreaterThan(localAiAcceptance);
    expect(activationCommitted).toBeGreaterThan(removePending);
    expect(deploy).toContain("releaseAcceptance.accepted");
    expect(deploy).toContain("aiAcceptance.ollamaPhase");
    expect(deploy).toContain("aiAcceptance.whiteShadowPhase");
    expect(deploy).toContain('Join-Path $controllerRoot "Test-LocalRelease.ps1"');
    expect(deploy).toContain('Join-Path $controllerRoot "Test-LocalAiRuntime.ps1"');
    expect(deploy).not.toContain('Join-Path $RepositoryRoot "scripts\\deployment\\Test-LocalRelease.ps1"');
    expect(deploy).toContain("ReleaseInstallationPending");
    expect(deploy).toContain("Recover-InterruptedReleaseInstallation");
    expect(deploy).toContain("Recover-InterruptedDeploymentActivation");
    expect(deploy).toContain("Read-PinnedNodeRuntimeInstallation");
    expect(deploy).not.toContain('Get-StableExecutable -Name "node.exe"');
  });

  it("binds the launched API and web bundle to one release SHA", async () => {
    const start = await deploymentScript("Start-LocalRelease.ps1");
    const verifyRuntime = start.indexOf("Test-RuntimeDependencyIntegrity");
    const inspectLive = start.indexOf("Get-LiveReleaseProcess");
    const startProcess = start.indexOf("Start-Process");
    expect(verifyRuntime).toBeGreaterThan(0);
    expect(inspectLive).toBeGreaterThan(verifyRuntime);
    expect(startProcess).toBeGreaterThan(inspectLive);
    expect(start).toContain('ORCHESTRATOR_HOST = "127.0.0.1"');
    expect(start).toContain("ORCHESTRATOR_RELEASE_SHA = $commitSha");
    expect(start).toContain("ORCHESTRATOR_WEB_DIST_ROOT = $webDistRoot");
    expect(start).toContain("-WindowStyle Hidden");
    expect(start).toContain("Write-AtomicJson -Layout $layout -Path $layout.Process");
    expect(start).toContain("runtimeDependencyReceiptSha256");
  });

  it("binds immutable dashboard inputs to the selected release payload", async () => {
    const config = await readFile(resolve("apps/api/src/config.ts"), "utf8");
    const composition = await readFile(resolve("apps/api/src/composition.ts"), "utf8");
    expect(config).toContain("releasePayloadRoot: string");
    expect(config).toContain("releasePayloadPath(releaseSha)");
    expect(composition).toContain(
      "loadDashboardSample(config.releasePayloadRoot)"
    );
    expect(composition).not.toContain(
      "loadDashboardSample(config.repositoryRoot)"
    );
  });

  it("hashes the complete dependency tree and binds it to an external immutable seal", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    expect(common).toContain('kind = "directory"');
    expect(common).toContain('kind = "link"');
    expect(common).toContain('kind = "file"');
    expect(common).toContain("nodeSha256");
    expect(common).toContain("nodeRuntimeArchiveSha256");
    expect(common).toContain("nodeRuntimeTreeSha256");
    expect(common).toContain("runtimeIntegritySha256");
    expect(common).toContain("Get-ChildItem -LiteralPath $releaseRootFull -Recurse -Force");
    expect(common).toContain("Assert-IntegritySealProtection");
    expect(common).toContain("Assert-ReleaseDirectoryProtection");
    expect(common).toContain('npmVersion -cne "10.9.8"');
    expect(common).not.toContain('(& ([string]$receipt.npmPath) --version');
  });

  it("installs and verifies the official D-backed Node runtime byte for byte", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    const installer = await deploymentScript("Install-PinnedNodeRuntime.ps1");
    expect(common).toContain("Expand-PinnedNodeArchive");
    expect(common).toContain("Test-PinnedNodeRuntime");
    expect(common).toContain("Read-PinnedNodeRuntimeInstallation");
    expect(common).toContain("Pinned Node.js runtime contains an undeclared file");
    expect(common).toContain("Pinned Node.js runtime contains an undeclared directory");
    expect(installer).toContain("Invoke-WebRequest");
    expect(installer).toContain("PinnedNodeArchiveSha256");
    expect(installer).toContain("Protect-PinnedNodeRuntime");
    expect(installer).toContain("Write-AtomicJson -Layout $layout -Path $layout.NodeRuntimeInstallation");
    expect(installer).toContain("Enter-DeploymentTransactionMutex");
  });

  it("validates the exact task identity, trigger, principal, action, and settings", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    for (const contract of [
      "Assert-ScheduledTaskDefinition",
      'TaskPath -cne "\\"',
      'LogonType -cne "Interactive"',
      'RunLevel -cne "Limited"',
      'CimClassName',
      'RestartInterval -cne "PT1M"',
      'ExecutionTimeLimit -cne "P3650D"',
      'MultipleInstances -cne "IgnoreNew"',
      "DisallowStartIfOnBatteries",
      "StopIfGoingOnBatteries"
    ]) {
      expect(common).toContain(contract);
    }
    const runnerStart = await deploymentScript("Start-GitHubRunner.ps1");
    expect(runnerStart).toContain("Assert-GitHubRunnerTaskRegistration");
    expect(runnerStart).toContain("ExpectedTreeSha256");
  });

  it("installs a frozen recovery controller and qualifies it only after live verification", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    const deploy = await deploymentScript("Deploy-LocalRelease.ps1");
    const rollback = await deploymentScript("Rollback-LocalRelease.ps1");
    expect(common).toContain("Test-RecoveryControllerManifest");
    expect(common).toContain("Read-LastKnownGoodRecoveryController");
    expect(common).toContain("Set-LastKnownGoodRecoveryController");
    expect(common).toContain('"Test-LocalAiRuntime.ps1"');
    expect(common).toContain("Read-DeploymentStateBackup");
    expect(common).toContain("backupManifestSha256");
    expect(deploy.indexOf("Set-LastKnownGoodRecoveryController")).toBeGreaterThan(
      deploy.indexOf("Get-LiveReleaseProcess")
    );
    expect(rollback).toContain("Rollback must run from the installed last-known-good recovery controller");
    const installer = await deploymentScript("Install-LocalProductionTask.ps1");
    expect(installer).toContain("ControllerActivationPending");
    expect(installer).toContain("Restore-PendingControllerActivation");
    expect(installer).toContain("Register-ScheduledTask");
    expect(installer).toContain("Assert-CurrentReleaseOperational");
    expect(installer).toContain("Stop-ApplicationForControllerRecovery");
    expect(installer).toContain("-Force");
  });

  it("keeps the recovery artifact Git helper isolated from the dot-sourced controller", async () => {
    const packager = await readFile(
      resolve("scripts/release/New-RecoveryControllerArtifact.ps1"),
      "utf8"
    );
    expect(packager).toContain("function Invoke-RecoveryArtifactGitText");
    expect(packager).not.toContain("function Invoke-GitText");
    expect(packager.match(/Invoke-RecoveryArtifactGitText/gu)).toHaveLength(4);
  });

  it("binds the controller manifest to the exact six physical script bytes", async () => {
    const manifest = JSON.parse(
      await deploymentScript("controller-manifest.json")
    );
    const expectedFiles = [
      "Deployment.Common.ps1",
      "Start-LocalRelease.ps1",
      "Stop-LocalRelease.ps1",
      "Rollback-LocalRelease.ps1",
      "Test-LocalRelease.ps1",
      "Test-LocalAiRuntime.ps1"
    ];
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.controllerVersion).toBe("1.0.0");
    expect(Object.keys(manifest.files).sort()).toEqual([...expectedFiles].sort());
    for (const name of expectedFiles) {
      const bytes = await readFile(resolve("scripts/deployment", name));
      expect(manifest.files[name]).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("keeps rollback acceptance inside the durable transaction", async () => {
    const rollback = await deploymentScript("Rollback-LocalRelease.ps1");
    const readiness = rollback.indexOf("Wait-ForReleaseHealth");
    const setLastKnownGood = rollback.indexOf("Set-LastKnownGoodRecoveryController", readiness);
    const releaseAcceptance = rollback.indexOf("Test-LocalRelease.ps1", setLastKnownGood);
    const aiAcceptance = rollback.indexOf("Test-LocalAiRuntime.ps1", releaseAcceptance);
    const removePending = rollback.indexOf("Remove-Item -LiteralPath $layout.Pending", aiAcceptance);
    const activationCommitted = rollback.indexOf("$activationCommitted = $true", removePending);
    expect(readiness).toBeGreaterThan(0);
    expect(setLastKnownGood).toBeGreaterThan(readiness);
    expect(releaseAcceptance).toBeGreaterThan(setLastKnownGood);
    expect(aiAcceptance).toBeGreaterThan(releaseAcceptance);
    expect(removePending).toBeGreaterThan(aiAcceptance);
    expect(activationCommitted).toBeGreaterThan(removePending);
  });

  it("records recoverable runner state before task creation and startup", async () => {
    const installer = await deploymentScript("Install-GitHubRunner.ps1");
    const installationBlock = installer.lastIndexOf("$installation = [ordered]@{");
    const durableState = installer.indexOf(
      "Write-AtomicJson -Layout $layout -Path $layout.RunnerInstallation",
      installationBlock
    );
    const ensureTask = installer.indexOf("$task = Ensure-GitHubRunnerTask", durableState);
    const startTask = installer.indexOf("Start-ScheduledTask -TaskName $TaskName", ensureTask);
    expect(installationBlock).toBeGreaterThan(0);
    expect(durableState).toBeGreaterThan(installationBlock);
    expect(ensureTask).toBeGreaterThan(durableState);
    expect(startTask).toBeGreaterThan(ensureTask);
    expect(installer).toContain('"--disableupdate"');
    expect(installer).toContain("ZeroFreeBSTR");
    expect(installer).not.toContain("GITHUB_TOKEN");
  });

  it("keeps deployment scripts free of protected-branch rewrites and unrelated cloud targets", async () => {
    const names = (await readdir(resolve("scripts/deployment"))).filter((name) =>
      name.endsWith(".ps1")
    );
    const combined = (
      await Promise.all(names.map(async (name) => await deploymentScript(name)))
    ).join("\n");
    for (const forbiddenGitMutation of [
      '@("reset"',
      '@("checkout"',
      '@("switch"',
      '@("merge"',
      "reset --hard"
    ]) {
      expect(combined).not.toContain(forbiddenGitMutation);
    }
    expect(combined).not.toMatch(/Azure|GitHub Pages/iu);
    expect(combined).not.toContain("Remove-Item Env:GITHUB_TOKEN");
  });
});
