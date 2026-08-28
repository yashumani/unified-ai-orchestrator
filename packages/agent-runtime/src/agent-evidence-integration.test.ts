import { LocalEvidenceStore } from "@unified-ai/evidence-index";
import type { ToolDefinition } from "@unified-ai/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, type OllamaAgentPort } from "./agent-loop.js";

const temporaryRoots: string[] = [];
const definitions: ToolDefinition[] = [
  {
    name: "repository.git_status",
    description: "Read Git status.",
    mode: "read",
    inputSchema: { type: "object" }
  }
];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("AgentRunner evidence integration", () => {
  it("round-trips a completed receipt through the immutable local store", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "unified-agent-evidence-"));
    temporaryRoots.push(repositoryRoot);
    const evidence = new LocalEvidenceStore({
      repositoryRoot,
      root: join(repositoryRoot, ".local", "evidence")
    });
    const ollama: OllamaAgentPort = {
      streamChat: async function* () {
        yield { type: "content" as const, content: "Evidence is durable." };
        yield {
          type: "complete" as const,
          metadata: {
            model: "qwen3:4b" as const,
            createdAt: "2026-08-28T05:00:00.000Z"
          }
        };
      }
    };
    const runner = new AgentRunner({
      ollama,
      tools: { listDefinitions: () => definitions, execute: vi.fn() },
      evidence,
      runId: () => "run-local-store",
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });

    const handle = runner.start({ message: "Prove storage." });
    const events = (async () => {
      for await (const _event of handle.events) {
        // Drain the stream so production-like completion cannot block.
      }
    })();
    const receipt = await handle.completion;
    await events;

    expect(await evidence.readAgentRunReceipt(receipt.runId)).toEqual(receipt);
    await expect(evidence.listAgentRunReceipts()).resolves.toEqual([receipt]);
  });
});
