import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(".github/workflows/fixture-ci.yml");

function actionUses(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
}

describe("public fixture CI workflow", () => {
  it("uses current official action majors with read-only permissions", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # actions/checkout@v7"
    );
    expect(workflow).toContain(
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # actions/setup-node@v6"
    );
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('node-version: "22.23.2"');
    expect(actionUses(workflow)).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"
    ]);
    for (const use of actionUses(workflow)) {
      expect(use).toMatch(/@[0-9a-f]{40}$/u);
    }
  });

  it("runs locked installation, repository verification, and real artifact qualification", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("npm ci --ignore-scripts --no-audit --no-fund");
    expect(workflow).toContain("npm run verify");
    expect(workflow).toContain("New-ReleaseArtifact.ps1");
    expect(workflow).toContain("New-RecoveryControllerArtifact.ps1");
    expect(workflow.match(/New-ReleaseArtifact\.ps1/gu)).toHaveLength(2);
    expect(workflow.match(/New-RecoveryControllerArtifact\.ps1/gu)).toHaveLength(2);
    expect(workflow).toContain("Release artifact creation is not deterministic");
    const secondAppBuild = workflow.lastIndexOf("New-ReleaseArtifact.ps1");
    const secondControllerBuild = workflow.lastIndexOf("New-RecoveryControllerArtifact.ps1");
    const determinismGate = workflow.indexOf("Release artifact creation is not deterministic");
    expect(determinismGate).toBeGreaterThan(secondAppBuild);
    expect(determinismGate).toBeGreaterThan(secondControllerBuild);
    expect(workflow).not.toContain("GITHUB_TOKEN");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("OLLAMA");
    expect(workflow).not.toContain("WHITESHADOW");
  });
});
