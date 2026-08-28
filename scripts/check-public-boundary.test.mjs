import { describe, expect, it } from "vitest";
import { findForbiddenPaths } from "./check-public-boundary.mjs";

describe("public repository boundary", () => {
  it("accepts public source and the environment example", () => {
    expect(
      findForbiddenPaths([
        "packages/contracts/src/index.ts",
        "sources/fixtures/conversation.synthetic.json",
        ".env.example"
      ])
    ).toEqual([]);
  });

  it.each([
    [".local/evidence/object.json", "local-runtime"],
    [".env", "environment-file"],
    [".env.production", "environment-file"],
    [".playwright-cli/profile/state.json", "playwright-profile"],
    ["sources/private/source.json", "private-source"],
    ["sources/chatgpt/conversation.json", "chatgpt-source"],
    ["data/raw/export.json", "raw-data"],
    ["capture.transcript.jsonl", "session-transcript"],
    ["project.session.jsonl", "session-transcript"],
    ["evidence.sqlite3", "database"],
    ["model-cache/blob.bin", "local-cache"]
  ])("rejects %s", (path, rule) => {
    expect(findForbiddenPaths([path])).toEqual([{ path, rule }]);
  });
});
