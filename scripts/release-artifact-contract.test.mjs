import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function script(name) {
  return await readFile(resolve("scripts/release", name), "utf8");
}

describe("release packaging and source synchronization contracts", () => {
  it("builds a version-pinned, ordered, hash-addressed runtime archive", async () => {
    const contents = await script("New-ReleaseArtifact.ps1");
    expect(contents).toContain("$expectedNodeVersion = 'v22.23.2'");
    expect(contents).toContain("--porcelain', '--untracked-files=all");
    expect(contents).toContain("$relativePaths.Sort([StringComparer]::Ordinal)");
    expect(contents).toContain("$archivePaths.Sort([StringComparer]::Ordinal)");
    expect(contents).toContain("$entry.LastWriteTime = $commitTimestamp");
    expect(contents).toContain("packageLockSha256 = $packageLockSha256");
    expect(contents).toContain("payloadSha256 = $payloadHashes");
    expect(contents).toContain("@('.npmrc', 'package.json', 'package-lock.json')");
    expect(contents).toContain("@('apps', 'packages', 'services')");
    expect(contents).toContain("sources\\fixtures");
  });

  it("rejects secrets, private inputs, dependency installs, and deployment state", async () => {
    const contents = await script("New-ReleaseArtifact.ps1");
    for (const forbidden of [
      "node_modules",
      ".git",
      ".local",
      "sources/private",
      "sources/chatgpt",
      ".env"
    ]) {
      expect(contents).toContain(forbidden);
    }
    expect(contents).toContain("Forbidden release payload path");
  });

  it("builds and packages a deterministic self-contained production server", async () => {
    const builder = await script("build-production-server-bundle.mjs");
    const packager = await script("New-ReleaseArtifact.ps1");
    expect(builder).toContain('buildKind = "esbuild-bundle-v1"');
    expect(builder).toContain('process.version !== "v22.23.2"');
    expect(builder).toContain('packages: "bundle"');
    expect(builder).toContain('platform: "node"');
    expect(builder).toContain('format: "esm"');
    expect(builder).toContain('target: "node22"');
    expect(builder).toContain('cliArguments[0] !== "--output-root"');
    expect(builder).toContain("outfile: absoluteOutput");
    expect(builder).toContain("Production server bundle creation is not byte-for-byte deterministic");
    expect(builder).toContain("Production server bundling emitted warnings");
    expect(builder).toContain("allowedRuntimeExternals.has(value)");
    expect(builder).toContain('runtimeFeatureGuard = "copilotkit-channels-disabled-v1"');
    expect(builder).toContain('requireBridge = "node-builtins-only-require-v1"');
    expect(builder).toContain('runtimeResolutionGuard = "node-builtins-only-v1"');
    expect(builder).toContain("schemaVersion: 2");
    expect(builder).toContain("nodeVersion: process.version");
    expect(builder).toContain("buildPlatform: process.platform");
    expect(builder).toContain("buildArchitecture: process.arch");
    expect(builder).toContain("reviewed SRI-pinned esbuild wrapper and platform binary");
    expect(builder).toContain("builderPackageIntegrity");
    expect(builder).toContain("builderBinaryIntegrity");
    expect(builder).toContain('channelActivationSettings[0] !== "activateChannels: false"');
    expect(builder).toContain('guardedImport = "import(CHANNELS_INTELLIGENCE_SPECIFIER)"');
    expect(builder).toContain("__rejectDynamicModuleResolution");
    expect(builder).toContain("Production bundle retained an unreviewed computed module-resolution path");
    expect(builder).toContain('expressRequireCount = hardened.split("__require(mod)").length - 1');
    expect(builder).toContain("server.bundle.mjs");
    expect(builder).toContain("server.bundle.json");
    expect(builder.indexOf("rm(absoluteReceipt")).toBeLessThan(
      builder.indexOf("rm(absoluteOutput,")
    );
    expect(builder.indexOf("rm(absoluteOutput,")).toBeLessThan(
      builder.indexOf("rename(outputTemporary, absoluteOutput)")
    );
    expect(builder.indexOf("rename(outputTemporary, absoluteOutput)")).toBeLessThan(
      builder.indexOf("rename(receiptTemporary, absoluteReceipt)")
    );
    expect(packager).toContain("npm run build:release --silent");
    expect(packager).toContain("--output-root $bundleGenerationRoot");
    expect(packager).toContain(
      "$files[$bundledRuntimePayloadPath] = Get-BundledRuntimeContainedPath"
    );
    expect(packager).not.toContain("foreach ($bundledRuntimePath in");
    expect(packager.match(/Read-BundledRuntimeBuildReceipt/gu)).toHaveLength(2);
    expect(packager).toContain("-ReleaseRoot $stagingRoot");
    expect(packager).toContain("$artifactTemporaryPath");
    expect(packager).toContain("Move-Item -LiteralPath $checksumTemporaryPath -Destination $checksumPath");
  });

  it("isolates generated outputs and revalidates the explicit source root before payload selection", async () => {
    const packager = await script("New-ReleaseArtifact.ps1");
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
    const clearInvocation = packager.indexOf(
      "Clear-GeneratedBuildOutputs\n  Write-Host"
    );
    const pushLocation = packager.indexOf(
      "Push-Location -LiteralPath $resolvedRepositoryRoot"
    );
    const sourceBuild = packager.indexOf("npm run build:release --silent");
    const payloadSelection = packager.indexOf(
      "$files = [System.Collections.Generic.Dictionary[string,string]]"
    );
    const sourceAssertions = packager.match(
      /Assert-RepositoryReleaseState -ExpectedSha \$CommitSha/gu
    );

    expect(packager).toContain("function Clear-GeneratedBuildOutputs");
    expect(packageJson.scripts["build:release"]).toContain(
      "tsc -b --pretty false --force"
    );
    expect(packager).toContain("Generated build output cannot be a reparse point");
    expect(packager).toContain(
      "Remove-Item -LiteralPath $distRoot -Recurse -Force"
    );
    expect(packager).toContain("Pop-Location");
    expect(clearInvocation).toBeGreaterThan(0);
    expect(clearInvocation).toBeLessThan(sourceBuild);
    expect(pushLocation).toBeGreaterThan(clearInvocation);
    expect(pushLocation).toBeLessThan(sourceBuild);
    expect(sourceAssertions).toHaveLength(2);
    expect(packager.lastIndexOf("Assert-RepositoryReleaseState -ExpectedSha $CommitSha"))
      .toBeGreaterThan(sourceBuild);
    expect(packager.lastIndexOf("Assert-RepositoryReleaseState -ExpectedSha $CommitSha"))
      .toBeLessThan(payloadSelection);
  });

  it(
    "behaviorally rejects malformed, forged, and reparse-backed bundle receipts",
    () => {
      const output = execFileSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          resolve("scripts/release/Test-BundledRuntimeContract.ps1"),
          "-RepositoryRoot",
          resolve(".")
        ],
        { encoding: "utf8" }
      );
      const result = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
      expect(result).toMatchObject({ accepted: true, validCases: 1, rejectedCases: 13 });
      expect(result.rejectedCaseNames).toContain("duplicate-key");
      expect(result.rejectedCaseNames).toContain("case-colliding-key");
      expect(result.rejectedCaseNames).toContain("selected-binary-lock-mismatch");
      expect(result.rejectedCaseNames).toContain("reparse-ancestor");
    },
    30_000
  );

  it("synchronizes only clean canonical main by fast-forward to exact origin SHA", async () => {
    const contents = await script("Sync-CanonicalMain.ps1");
    expect(contents).toContain("--porcelain', '--untracked-files=all");
    expect(contents).toContain("https://github.com/yashumani/unified-ai-orchestrator.git");
    expect(contents).toContain("credential.helper=");
    expect(contents).toContain("origin/main $remoteSha does not match workflow SHA $ExpectedSha");
    expect(contents).toContain("merge', '--ff-only'");
    expect(contents).not.toContain("reset --hard");
    expect(contents).not.toContain("--force");
  });

  it("requires rollback input to equal the previous immutable release pointer", async () => {
    const contents = await script("Confirm-RollbackTarget.ps1");
    expect(contents).toContain(".local\\deployment\\previous.json");
    expect(contents).toContain("$previous.commitSha");
    expect(contents).toContain("$previousSha -cne $ExpectedPreviousSha");
  });
});
