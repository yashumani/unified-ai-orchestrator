import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEvidenceStore } from "@unified-ai/evidence-index";
import {
  importChatGptExport,
  normalizeChatGptExport
} from "./import-chatgpt-export.js";

const temporaryRoots: string[] = [];

function syntheticConversation(id = "conversation-1") {
  return {
    id,
    title: "Synthetic portfolio planning",
    create_time: 1_788_000_000,
    update_time: 1_788_000_300,
    current_node: "assistant-main",
    mapping: {
      root: {
        id: "root",
        parent: null,
        children: ["user-main"]
      },
      "user-main": {
        id: "user-main",
        parent: "root",
        children: ["assistant-main", "assistant-abandoned"],
        message: {
          id: "message-user",
          author: { role: "user" },
          create_time: 1_788_000_010,
          content: {
            content_type: "text",
            parts: [
              "Keep source repositories read-only.",
              { attachment: "ignored-synthetic-file" }
            ]
          }
        }
      },
      "assistant-main": {
        id: "assistant-main",
        parent: "user-main",
        children: [],
        message: {
          id: "message-assistant-main",
          author: { role: "assistant" },
          create_time: 1_788_000_020,
          content: {
            content_type: "text",
            parts: ["I will produce a cited recommendation."]
          }
        }
      },
      "assistant-abandoned": {
        id: "assistant-abandoned",
        parent: "user-main",
        children: [],
        message: {
          id: "message-assistant-abandoned",
          author: { role: "assistant" },
          create_time: 1_788_000_015,
          content: {
            content_type: "text",
            parts: ["This abandoned branch must not be imported."]
          }
        }
      }
    }
  };
}

async function makeStore(): Promise<{
  store: LocalEvidenceStore;
  evidenceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "uao-chat-export-test-"));
  temporaryRoots.push(root);
  const repositoryRoot = join(root, "repository");
  const evidenceRoot = join(repositoryRoot, ".local", "evidence");
  await mkdir(repositoryRoot);
  return {
    store: new LocalEvidenceStore({ root: evidenceRoot, repositoryRoot }),
    evidenceRoot
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("ChatGPT export normalization", () => {
  it("follows the active conversation path and ignores attachments", () => {
    const snapshots = normalizeChatGptExport([syntheticConversation()], {
      projectId: "app-development-export"
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.projectId).toBe("app-development-export");
    expect(snapshots[0]?.turns.map((turn) => turn.content)).toEqual([
      "Keep source repositories read-only.",
      "I will produce a cited recommendation."
    ]);
    expect(JSON.stringify(snapshots)).not.toContain("ignored-synthetic-file");
    expect(JSON.stringify(snapshots)).not.toContain("abandoned branch");
  });

  it("rejects duplicate conversation identities before ingestion", () => {
    expect(() =>
      normalizeChatGptExport([
        syntheticConversation("same-id"),
        syntheticConversation("same-id")
      ])
    ).toThrow(/duplicate ChatGPT conversation identity/u);
  });

  it("rejects malformed active paths and unsupported actor roles", () => {
    const malformed = syntheticConversation();
    malformed.current_node = "missing-node";
    expect(() => normalizeChatGptExport([malformed])).toThrow(
      /active path references a missing node/u
    );

    const unsupported = syntheticConversation();
    unsupported.mapping["user-main"].message.author.role = "browser";
    expect(() => normalizeChatGptExport([unsupported])).toThrow(
      /unsupported ChatGPT actor/u
    );
  });

  it("validates the complete export before writing any evidence", async () => {
    const { store, evidenceRoot } = await makeStore();
    const malformed = syntheticConversation("malformed");
    malformed.mapping["assistant-main"].message.create_time = Number.NaN;

    await expect(
      importChatGptExport([syntheticConversation("valid"), malformed], store)
    ).rejects.toThrow(/timestamp/u);

    await expect(readdir(evidenceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ingests every validated conversation with immutable receipts", async () => {
    const { store } = await makeStore();
    const result = await importChatGptExport(
      [syntheticConversation("one"), syntheticConversation("two")],
      store,
      { projectId: "app-development-export" }
    );

    expect(result.snapshots).toHaveLength(2);
    expect(result.ingestions).toHaveLength(2);
    expect(result.ingestions.every((entry) => entry.receipt.outcome === "succeeded"))
      .toBe(true);
  });
});
