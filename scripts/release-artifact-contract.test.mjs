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
