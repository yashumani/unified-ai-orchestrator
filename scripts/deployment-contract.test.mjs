import { readFile, readdir } from "node:fs/promises";
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
  });

  it("installs immutable payloads before atomic activation and exact-SHA readiness", async () => {
    const deploy = await deploymentScript("Deploy-LocalRelease.ps1");
    const validateArchive = deploy.indexOf("Test-ReleaseArchive");
    const installDependencies = deploy.indexOf("ci --omit=dev --ignore-scripts");
    const activatePointer = deploy.indexOf("-Path $layout.Current");
    const readiness = deploy.indexOf("Wait-ForReleaseHealth");
    expect(validateArchive).toBeGreaterThan(0);
    expect(installDependencies).toBeGreaterThan(validateArchive);
    expect(activatePointer).toBeGreaterThan(installDependencies);
    expect(readiness).toBeGreaterThan(activatePointer);
    expect(deploy).toContain("Rollback-on-failure");
  });

  it("binds the launched API and web bundle to one release SHA", async () => {
    const start = await deploymentScript("Start-LocalRelease.ps1");
    expect(start).toContain('ORCHESTRATOR_HOST = "127.0.0.1"');
    expect(start).toContain("ORCHESTRATOR_RELEASE_SHA = $commitSha");
    expect(start).toContain("ORCHESTRATOR_WEB_DIST_ROOT = $webDistRoot");
    expect(start).toContain("-WindowStyle Hidden");
    expect(start).toContain("Write-AtomicJson -Layout $layout -Path $layout.Process");
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
