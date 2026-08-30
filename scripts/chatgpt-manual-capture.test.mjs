import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/chatgpt-manual-capture.ps1");

describe("manual ChatGPT Playwright capture guardrails", () => {
  it("limits the operator to open, snapshot, and close", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain('[ValidateSet("open", "snapshot", "close")]');
    expect(script).toContain('"https://chatgpt.com/"');
    expect(script).toContain('"@playwright/cli"');
  });

  it("stores snapshots only under ignored local evidence", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain('".local\\imports\\chatgpt\\playwright"');
    expect(script).not.toContain("output/playwright");
  });

  it("contains no credential-entry or browser-state extraction commands", async () => {
    const script = await readFile(scriptPath, "utf8");
    const prohibited = [
      " fill ",
      " type ",
      "storageState",
      "context.cookies",
      "document.cookie",
      "password",
      "credential="
    ];

    for (const token of prohibited) {
      expect(script.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });
});
