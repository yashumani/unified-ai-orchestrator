import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function deploymentScript(name) {
  return await readFile(resolve("scripts/deployment", name), "utf8");
}

function powershellFunction(source, name) {
  const marker = `function ${name} {`;
  const start = source.indexOf(marker);
  expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nfunction ", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

function symbolCount(source, name) {
  return source.match(new RegExp(`\\b${name}\\b`, "gu"))?.length ?? 0;
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
    const writeRuntimeReceipt = deploy.indexOf("Write-SealedRuntimeDependencyAttestation");
    const activatePointer = deploy.indexOf("-Path $layout.Current");
    const readiness = deploy.indexOf("Wait-ForReleaseHealth");
    expect(validateArchive).toBeGreaterThan(0);
    expect(moveToFinal).toBeGreaterThan(validateArchive);
    expect(installDependencies).toBeGreaterThan(moveToFinal);
    expect(writeRuntimeReceipt).toBeGreaterThan(installDependencies);
    expect(activatePointer).toBeGreaterThan(writeRuntimeReceipt);
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
    expect(deploy).toContain("Read-PinnedNodeRuntimeAttestation");
    expect(deploy).not.toContain('Get-StableExecutable -Name "node.exe"');
  });

  it("binds the launched API and web bundle to one release SHA", async () => {
    const start = await deploymentScript("Start-LocalRelease.ps1");
    const verifyRuntime = start.indexOf("Test-SealedRuntimeDependencyAttestation");
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
    expect(start).not.toContain("Test-RuntimeDependencyIntegrityFullAudit");
    expect(start).not.toContain("Assert-ReleaseDirectoryProtection");
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

  it("seals the canonical installed dependency graph before activation without a per-file tree scan", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    const deploy = await deploymentScript("Deploy-LocalRelease.ps1");
    const writer = powershellFunction(common, "Write-SealedRuntimeDependencyAttestation");
    const graph = powershellFunction(common, "Get-PinnedNpmDependencyGraphReceipt");
    const canonicalGraph = powershellFunction(common, "Get-CanonicalNpmDependencyGraphReceipt");
    expect(symbolCount(deploy, "Write-SealedRuntimeDependencyAttestation")).toBe(1);
    expect(deploy).not.toMatch(/\bWrite-RuntimeDependencyIntegrity\b/u);
    expect(deploy).not.toContain("Get-RuntimeDependencyTreeReceipt");
    expect(deploy).not.toContain("Test-RuntimeDependencyIntegrityFullAudit");
    expect(writer).not.toContain("Get-RuntimeDependencyTreeReceipt");
    expect(graph).toContain("Invoke-BoundedProcess");
    expect(graph).toContain("RuntimeAttestationGraphTimeoutSeconds");
    for (const npmGraphArgument of ['"ls"', '"--omit=dev"', '"--all"', '"--json"']) {
      expect(graph).toContain(npmGraphArgument);
    }
    for (const graphBinding of [
      "attestationKind = $script:RuntimeAttestationKind",
      "dependencyGraphSha256",
      "dependencyGraphNodeCount",
      "hiddenPackageLockSha256",
      "packageLockSha256",
      "releaseManifestSha256",
      "criticalPayloadSha256",
      "npmVersion",
      "npmSha256"
    ]) {
      expect(writer).toContain(graphBinding);
    }
    expect(writer).toContain("schemaVersion = 4");
    expect(writer).toContain("schemaVersion = 2");
    expect(writer).toContain("runtimeIntegritySha256 = $receiptSha256");
    expect(writer).toContain("dependencyGraphSha256 = [string]$graph.dependencyGraphSha256");
    expect(writer).toContain("releaseManifestSha256 = [string]$criticalPayload.releaseManifestSha256");
    expect(common).toContain('$script:RuntimeAttestationKind = "npm-lock-graph-v1"');
    expect(common).toContain("$script:RuntimeAttestationGraphTimeoutSeconds = 120");
    for (const phase of ["npm-graph-start", "npm-graph-complete"]) {
      expect(graph).toContain(phase);
    }
    expect(canonicalGraph).toContain("$child.Count -eq 0");
    expect(canonicalGraph).toContain("platform-omitted optional dependencies");
    expect(canonicalGraph).toContain("non-empty node without a version");
    for (const phase of ["release-protection-start", "release-protection-complete", "seal-complete"]) {
      expect(writer).toContain(phase);
    }

    const installDependencies = deploy.indexOf("ci --omit=dev --ignore-scripts");
    const writeRuntimeReceipt = deploy.indexOf("Write-SealedRuntimeDependencyAttestation");
    const activatePointer = deploy.indexOf("-Path $layout.Current");
    const graphAttestation = writer.indexOf("Get-PinnedNpmDependencyGraphReceipt");
    const writeReceipt = writer.indexOf("Write-AtomicJson -Layout $Layout -Path $receiptPath");
    const protectRelease = writer.indexOf("Protect-ReleaseDirectory");
    const writeSeal = writer.indexOf("Write-AtomicJson -Layout $Layout -Path $sealPath");
    const verifySeal = writer.indexOf("Test-SealedRuntimeDependencyAttestation");
    expect(writeRuntimeReceipt).toBeGreaterThan(installDependencies);
    expect(activatePointer).toBeGreaterThan(writeRuntimeReceipt);
    expect(graphAttestation).toBeGreaterThan(0);
    expect(writeReceipt).toBeGreaterThan(graphAttestation);
    expect(protectRelease).toBeGreaterThan(writeReceipt);
    expect(writeSeal).toBeGreaterThan(protectRelease);
    expect(verifySeal).toBeGreaterThan(writeSeal);
  });

  it("streams bounded child output and terminates the process tree at the limit", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    const boundedProcess = powershellFunction(common, "Invoke-BoundedProcess");
    const hardening = await deploymentScript("Test-DeploymentHardening.ps1");
    expect(boundedProcess).toContain("ReadAsync");
    expect(boundedProcess).toContain("combined output exceeded its reviewed bound");
    expect(boundedProcess).toContain("$process.Kill($true)");
    expect(boundedProcess).toContain("process tree did not exit after termination");
    expect(boundedProcess).toContain("New-BoundedProcessJob");
    expect(boundedProcess).toContain("$job.Terminate()");
    expect(common).toContain("JobObjectLimitKillOnJobClose");
    expect(common).toContain("AssignProcessToJobObject");
    expect(hardening).toContain("boundedProcessTreeTermination = $true");
    expect(hardening).toContain("Synthetic exited-parent process-tree fixture");
    expect(boundedProcess).not.toContain("ReadToEndAsync");
    expect(boundedProcess.indexOf("combined output exceeded its reviewed bound")).toBeLessThan(
      boundedProcess.indexOf("stdout = $stdoutBuilder.ToString()")
    );
  });

  it("keeps normal deploy, start, acceptance, and rollback on bounded sealed attestation", async () => {
    const deploy = await deploymentScript("Deploy-LocalRelease.ps1");
    const start = await deploymentScript("Start-LocalRelease.ps1");
    const acceptance = await deploymentScript("Test-LocalRelease.ps1");
    const rollback = await deploymentScript("Rollback-LocalRelease.ps1");

    for (const script of [deploy, start, rollback]) {
      expect(script).toContain("Test-SealedRuntimeDependencyAttestation");
      expect(script).not.toContain("Test-RuntimeDependencyIntegrityFullAudit");
      expect(script).not.toMatch(/\bTest-RuntimeDependencyIntegrity\b/u);
      expect(script).not.toContain("Assert-ReleaseDirectoryProtection");
      expect(script).not.toContain("Get-RuntimeDependencyTreeReceipt");
    }

    expect(acceptance).toContain("[switch]$FullAudit");
    expect(acceptance).toContain("Test-SealedRuntimeDependencyAttestation");
    expect(acceptance).toContain("Test-RuntimeDependencyIntegrityFullAudit");
    expect(acceptance).toContain("runtimeAttestationMode");
    expect(acceptance).toContain("runtimeReceipt.attestationMode");
    const fullAuditBranch = acceptance.indexOf("if ($FullAudit)");
    const fullAuditCall = acceptance.indexOf("Test-RuntimeDependencyIntegrityFullAudit");
    const sealedCall = acceptance.indexOf("Test-SealedRuntimeDependencyAttestation");
    expect(fullAuditBranch).toBeGreaterThan(0);
    expect(fullAuditCall).toBeGreaterThan(fullAuditBranch);
    expect(sealedCall).toBeGreaterThan(fullAuditCall);
  });

  it("binds fast attestation to the exact sealed release and keeps a recursive offline audit", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    const sealed = powershellFunction(common, "Test-SealedRuntimeDependencyAttestation");
    const fullAudit = powershellFunction(common, "Test-RuntimeDependencyIntegrityFullAudit");
    const compatibility = powershellFunction(common, "Test-RuntimeDependencyIntegrity");
    const boundedAcl = powershellFunction(common, "Assert-BoundedReleaseDirectoryProtection");
    const criticalPaths = powershellFunction(common, "Get-BoundedReleaseCriticalPaths");
    const protectRelease = powershellFunction(common, "Protect-ReleaseDirectory");

    for (const binding of [
      "Assert-ContainedPath",
      "Get-CriticalReleasePayloadAttestation",
      "commitSha",
      "packageLockSha256",
      "releaseManifestSha256",
      "criticalPayloadSha256",
      "ExpectedReceiptSha256",
      "runtimeIntegritySha256",
      "Assert-IntegritySealProtection",
      "Read-PinnedNodeRuntimeAttestation",
      "nodeSha256",
      "nodeRuntimeArchiveSha256",
      "nodeRuntimeTreeSha256",
      "npmVersion",
      "npmSha256",
      "dependencyGraphSha256",
      "dependencyGraphNodeCount",
      "hiddenPackageLockSha256",
      "Get-BoundedReleaseCriticalPaths",
      "Assert-BoundedReleaseDirectoryProtection"
    ]) {
      expect(sealed).toContain(binding);
    }
    expect(sealed).not.toContain("Get-RuntimeDependencyTreeReceipt");
    expect(sealed).not.toContain("Assert-ReleaseDirectoryProtection");
    expect(sealed).toContain("schemaVersion");
    expect(sealed).toContain("attestationKind");
    expect(sealed).toContain("releaseManifestSha256");
    expect(sealed).toContain("legacyReceipt");
    expect(sealed).toContain("seal.schemaVersion -ne 1");
    expect(sealed).toContain("seal.schemaVersion -ne 2");
    expect(boundedAcl).not.toMatch(/Get-ChildItem[^\n]*-Recurse/u);
    expect(boundedAcl).not.toContain("-Recursive");
    expect(boundedAcl).not.toMatch(/\/(?:T|verify)\b/iu);
    for (const criticalPath of [
      "release-manifest.json",
      "runtime-integrity.json",
      "node_modules",
      ".package-lock.json"
    ]) {
      expect(criticalPaths).toContain(criticalPath);
    }
    for (const criticalPayload of [
      '"package.json"',
      '"package-lock.json"',
      '"apps/api/package.json"',
      '"apps/api/dist/server.js"',
      '"apps/web/dist/index.html"'
    ]) {
      expect(common).toContain(criticalPayload);
    }
    expect(criticalPaths).toContain("256");
    expect(criticalPaths).toContain("WorkspaceLinks.links");
    expect(criticalPaths).toContain("linkFullPath");
    expect(criticalPaths).toContain("targetFullPath");
    expect(protectRelease).toContain("(OI)(CI)");
    expect(protectRelease).toContain("Assert-BoundedReleaseDirectoryProtection");
    expect(protectRelease).toContain("RuntimeAttestationProtectionTimeoutSeconds");
    expect(common).toContain("$script:RuntimeAttestationProtectionTimeoutSeconds = 30");
    expect(protectRelease).not.toMatch(/\/(?:reset|T|verify)\b/iu);
    expect(protectRelease).not.toMatch(/Get-ChildItem[^\n]*-Recurse/u);

    expect(fullAudit).toContain("Test-SealedRuntimeDependencyAttestation");
    expect(fullAudit).toContain("Get-RuntimeDependencyTreeReceipt");
    expect(fullAudit).toContain("Assert-ReleaseDirectoryProtection");
    expect(fullAudit).toContain("Schema 4 full audit requires an externally trusted expected tree SHA-256");
    expect(compatibility).toContain("ExpectedTreeSha256");
    expect(compatibility).toContain("Test-RuntimeDependencyIntegrityFullAudit");
    expect(await deploymentScript("Test-LocalRelease.ps1")).toContain(
      "ExpectedFullAuditTreeSha256"
    );
    expect(await deploymentScript("Test-LocalRelease.ps1")).not.toContain(
      "FullAudit requires an externally trusted"
    );
  });

  it("quarantines interrupted installs with a same-volume non-traversing move", async () => {
    const common = await deploymentScript("Deployment.Common.ps1");
    const quarantine = powershellFunction(common, "Move-InterruptedReleasePathToFailed");
    const recovery = powershellFunction(common, "Recover-InterruptedReleaseInstallation");

    expect(quarantine).toContain("Assert-ContainedPath");
    expect(quarantine).toContain("Get-ReleaseRoot -Layout $Layout -CommitSha $CommitSha");
    expect(quarantine).toContain('"$CommitSha-$OperationId-$Kind"');
    expect(quarantine).toContain("$Kind");
    expect(quarantine).toContain("$expectedSource");
    expect(quarantine).toContain("GetPathRoot");
    expect(quarantine).toContain("[System.IO.Directory]::Move");
    expect(quarantine).toContain("[System.IO.FileAttributes]::ReparsePoint");
    expect(quarantine).not.toContain("Assert-TreeContainsNoReparsePoints");
    expect(quarantine).not.toMatch(/Get-ChildItem[^\n]*-Recurse/u);
    expect(quarantine).not.toContain("ResolveLinkTarget");
    expect(symbolCount(recovery, "Move-InterruptedReleasePathToFailed")).toBeGreaterThanOrEqual(2);
    expect(recovery.indexOf("Assert-ReleaseInstallationIsUnreferenced")).toBeLessThan(
      recovery.indexOf("Move-InterruptedReleasePathToFailed")
    );
  });

  it("starts the selected process before beginning the health wait", async () => {
    const start = await deploymentScript("Start-LocalRelease.ps1");
    const deploy = await deploymentScript("Deploy-LocalRelease.ps1");
    const rollback = await deploymentScript("Rollback-LocalRelease.ps1");
    const processLaunch = start.indexOf("Start-Process");
    const supervisedHealth = start.indexOf("Wait-ForReleaseHealth", processLaunch);
    expect(processLaunch).toBeGreaterThan(0);
    expect(supervisedHealth).toBeGreaterThan(processLaunch);
    expect(deploy.indexOf("Wait-ForReleaseHealth")).toBeGreaterThan(
      deploy.indexOf("Start-ScheduledTask")
    );
    expect(rollback.indexOf("Wait-ForReleaseHealth")).toBeGreaterThan(
      rollback.indexOf("Start-ScheduledTask")
    );
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
    expect(runnerStart).toContain("Read-GitHubRunnerInstallation");
    expect(runnerStart).not.toContain("Assert-GitHubRunnerTaskRegistration");
    expect(runnerStart).toContain("ExpectedTreeSha256");
    expect(runnerStart.indexOf("ExpectedTreeSha256")).toBeLessThan(
      runnerStart.indexOf("Write-AtomicJson -Layout $layout -Path $layout.RunnerProcess")
    );
    expect(runnerStart.indexOf("Write-AtomicJson -Layout $layout -Path $layout.RunnerProcess")).toBeLessThan(
      runnerStart.indexOf('Join-Path $layout.RunnerRoot "run.cmd"')
    );
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
    const controllerInstaller = await deploymentScript("Install-RecoveryController.ps1");
    expect(installer).toContain("ControllerActivationPending");
    expect(installer).toContain("Restore-PendingControllerActivation");
    expect(installer).toContain("Register-ScheduledTask");
    expect(installer).toContain("Assert-CurrentReleaseOperational");
    expect(installer).toContain("Stop-ApplicationForControllerRecovery");
    expect(common).toContain('$script:SupportedControllerVersions = @("1.0.0", $script:CanonicalControllerVersion)');
    expect(common).toContain("Assert-SupportedControllerVersion");
    expect(installer).toContain("hadPreviousLastKnownGoodController");
    expect(installer).toContain("previousLastKnownGoodController");
    expect(installer).toContain("schemaVersion = 3");
    expect(installer).toContain("$pendingSchemaVersion -notin @(2, 3)");
    expect(installer).toContain("$restoreLastKnownGoodSnapshot = $pendingSchemaVersion -eq 3");
    expect(controllerInstaller).toContain("Assert-SupportedControllerVersion");
    expect(controllerInstaller).toContain("-ExpectedControllerVersion ([string]$pending.controllerVersion)");
    const qualifyNextController = installer.lastIndexOf("Set-LastKnownGoodRecoveryController");
    const commitControllerActivation = installer.indexOf(
      "Remove-Item -LiteralPath $layout.ControllerActivationPending",
      qualifyNextController
    );
    expect(qualifyNextController).toBeGreaterThan(installer.indexOf("Start-ScheduledTask"));
    expect(commitControllerActivation).toBeGreaterThan(qualifyNextController);
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
    expect(manifest.controllerVersion).toBe("1.0.1");
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
    const transaction = rollback.indexOf("Enter-DeploymentTransactionMutex");
    const activationRecovery = rollback.indexOf("Recover-InterruptedDeploymentActivation", transaction);
    const installationRecovery = rollback.indexOf("Recover-InterruptedReleaseInstallation", activationRecovery);
    const firstLockedAuthority = rollback.indexOf(
      "$lockedRecoveryController = Read-LastKnownGoodRecoveryController",
      transaction
    );
    const secondLockedAuthority = rollback.indexOf(
      "$lockedRecoveryController = Read-LastKnownGoodRecoveryController",
      firstLockedAuthority + 1
    );
    expect(readiness).toBeGreaterThan(0);
    expect(setLastKnownGood).toBeGreaterThan(readiness);
    expect(releaseAcceptance).toBeGreaterThan(setLastKnownGood);
    expect(aiAcceptance).toBeGreaterThan(releaseAcceptance);
    expect(removePending).toBeGreaterThan(aiAcceptance);
    expect(activationCommitted).toBeGreaterThan(removePending);
    expect(firstLockedAuthority).toBeLessThan(activationRecovery);
    expect(secondLockedAuthority).toBeGreaterThan(installationRecovery);
    expect(rollback).toContain("authority changed while rollback waited for the deployment lock");
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
