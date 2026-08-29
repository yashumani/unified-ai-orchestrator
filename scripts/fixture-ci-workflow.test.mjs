import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(".github/workflows/fixture-ci.yml");

describe("public fixture CI workflow", () => {
  it("uses current official action majors with read-only permissions", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("actions/checkout@v7");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("persist-credentials: false");
  });

  it("runs only locked, script-free installation and repository verification", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("npm ci --ignore-scripts");
    expect(workflow).toContain("npm run verify");
    expect(workflow).not.toContain("GITHUB_TOKEN");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("OLLAMA");
    expect(workflow).not.toContain("WHITESHADOW");
  });
});
