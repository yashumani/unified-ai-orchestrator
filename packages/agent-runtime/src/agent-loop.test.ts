import type {
  AgentRunEvent,
  AgentRunReceipt,
  ToolCall,
  ToolDefinition,
  ToolResult
} from "@unified-ai/contracts";
import type { OllamaChatRequest, OllamaStreamEvent } from "@unified-ai/ollama-client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AgentEvidenceError,
  AgentRunner,
  MAX_AGENT_ITERATIONS,
  type AgentEvidencePort,
  type OllamaAgentPort,
  type RepositoryToolPort
} from "./agent-loop.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

class FakeEvidence implements AgentEvidencePort {
  readonly objects: unknown[] = [];
  readonly receipts: AgentRunReceipt[] = [];
  failReceipt = false;

  async putObject(value: unknown) {
    this.objects.push(value);
    return { sha256: hash(value), relativePath: `objects/${this.objects.length}.json` };
  }

  async putAgentRunReceipt(receipt: AgentRunReceipt) {
    if (this.failReceipt) {
      throw new Error("disk unavailable");
    }
    this.receipts.push(receipt);
    return { sha256: hash(receipt), relativePath: `agent-runs/${receipt.runId}.json` };
  }
}

const definitions: ToolDefinition[] = [
  {
    name: "repository.git_status",
    description: "Read Git status.",
    mode: "read",
    inputSchema: { type: "object" }
  }
];

async function collect(handle: ReturnType<AgentRunner["start"]>) {
  const events: AgentRunEvent[] = [];
  const reader = (async () => {
    for await (const event of handle.events) {
      events.push(event);
    }
  })();
  const receipt = await handle.completion;
  await reader;
  return { events, receipt };
}

function textOllama(content = "Done with evidence."): OllamaAgentPort {
  return {
    streamChat: async function* (): AsyncGenerator<OllamaStreamEvent> {
      yield { type: "content", content };
      yield {
        type: "complete",
        metadata: { model: "qwen3:4b", createdAt: "2026-08-28T05:00:00.000Z" }
      };
    }
  };
}

describe("AgentRunner", () => {
  it("emits completion only after persisting input, output, and receipt", async () => {
    const evidence = new FakeEvidence();
    const tools: RepositoryToolPort = {
      listDefinitions: () => definitions,
      execute: vi.fn()
    };
    const runner = new AgentRunner({
      ollama: textOllama(),
      tools,
      evidence,
      runId: () => "run-test",
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });
    const { events, receipt } = await collect(runner.start({ message: "Inspect the repo." }));

    expect(receipt.status).toBe("succeeded");
    expect(evidence.objects).toHaveLength(2);
    expect(evidence.receipts).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "assistant_delta",
      "run_completed"
    ]);
  });

  it("executes requested tools serially and sends results into the next turn", async () => {
    const requests: OllamaChatRequest[] = [];
    let turn = 0;
    const ollama: OllamaAgentPort = {
      streamChat: async function* (request): AsyncGenerator<OllamaStreamEvent> {
        requests.push(request);
        turn += 1;
        if (turn === 1) {
          yield {
            type: "tool_call",
            toolCall: { name: "repository.git_status", arguments: {} }
          };
        } else {
          yield { type: "content", content: "The feature branch is clean." };
        }
        yield {
          type: "complete",
          metadata: { model: "qwen3:4b", createdAt: "2026-08-28T05:00:00.000Z" }
        };
      }
    };
    const execute = vi.fn(async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.callId,
      toolName: call.toolName,
      ok: true,
      summary: "Status read.",
      data: { content: "## feature/test" },
      truncated: false
    }));
    const evidence = new FakeEvidence();
    const runner = new AgentRunner({
      ollama,
      tools: { listDefinitions: () => definitions, execute },
      evidence,
      runId: () => "run-tool-test",
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });
    const { events, receipt } = await collect(runner.start({ message: "Check status." }));

    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", tool_name: "repository.git_status" });
    expect(receipt.toolCalls).toMatchObject([{ outcome: "succeeded", policyCode: "allowed" }]);
    expect(events.map((event) => event.type)).toContain("tool_completed");
  });

  it("records policy-blocked tools without treating them as executed", async () => {
    let turn = 0;
    const ollama: OllamaAgentPort = {
      streamChat: async function* (): AsyncGenerator<OllamaStreamEvent> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool_call", toolCall: { name: "repository.git_status", arguments: {} } };
        } else {
          yield { type: "content", content: "The operation was blocked." };
        }
        yield { type: "complete", metadata: { model: "qwen3:4b", createdAt: "2026-08-28T05:00:00.000Z" } };
      }
    };
    const evidence = new FakeEvidence();
    const runner = new AgentRunner({
      ollama,
      tools: {
        listDefinitions: () => definitions,
        execute: async (call) => ({
          callId: call.callId,
          toolName: call.toolName,
          ok: false,
          summary: "Policy blocked the tool.",
          data: {
            policy: {
              allowed: false,
              code: "workspace_untrusted",
              reason: "Grant missing.",
              checkedAt: "2026-08-28T05:00:00.000Z"
            }
          },
          truncated: false
        })
      },
      evidence,
      runId: () => "run-blocked-test",
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });
    const { receipt } = await collect(runner.start({ message: "Attempt tool." }));
    expect(receipt.toolCalls).toMatchObject([
      { outcome: "blocked", policyCode: "workspace_untrusted" }
    ]);
  });

  it("stops after the fixed iteration limit", async () => {
    const ollama: OllamaAgentPort = {
      streamChat: async function* (): AsyncGenerator<OllamaStreamEvent> {
        yield { type: "tool_call", toolCall: { name: "repository.git_status", arguments: {} } };
        yield { type: "complete", metadata: { model: "qwen3:4b", createdAt: "2026-08-28T05:00:00.000Z" } };
      }
    };
    const runner = new AgentRunner({
      ollama,
      tools: {
        listDefinitions: () => definitions,
        execute: async (call) => ({
          callId: call.callId,
          toolName: call.toolName,
          ok: true,
          summary: "read",
          truncated: false
        })
      },
      evidence: new FakeEvidence(),
      runId: () => "run-limit-test",
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });
    const { receipt } = await collect(runner.start({ message: "Keep going." }));
    expect(receipt.status).toBe("stopped");
    expect(receipt.iterations).toBe(MAX_AGENT_ITERATIONS);
  });

  it("stops before executing a batch that exceeds the tool-call limit", async () => {
    const ollama: OllamaAgentPort = {
      streamChat: async function* (): AsyncGenerator<OllamaStreamEvent> {
        for (let index = 0; index < 13; index += 1) {
          yield {
            type: "tool_call",
            toolCall: { name: "repository.git_status", arguments: {} }
          };
        }
        yield {
          type: "complete",
          metadata: { model: "qwen3:4b", createdAt: "2026-08-28T05:00:00.000Z" }
        };
      }
    };
    const execute = vi.fn();
    const runner = new AgentRunner({
      ollama,
      tools: { listDefinitions: () => definitions, execute },
      evidence: new FakeEvidence(),
      runId: () => "run-tool-limit",
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });
    const { receipt } = await collect(runner.start({ message: "Request too much." }));
    expect(receipt.status).toBe("stopped");
    expect(execute).not.toHaveBeenCalled();
  });

  it("persists a cancelled receipt when the caller cancels", async () => {
    const runner = new AgentRunner({
      ollama: textOllama(),
      tools: { listDefinitions: () => definitions, execute: vi.fn() },
      evidence: new FakeEvidence(),
      runId: () => "run-cancelled",
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });
    const handle = runner.start({ message: "Cancel safely." });
    handle.cancel();
    const { receipt, events } = await collect(handle);
    expect(receipt.status).toBe("cancelled");
    expect(events.at(-1)?.type).toBe("run_cancelled");
  });

  it("never reports completion when receipt persistence fails", async () => {
    const evidence = new FakeEvidence();
    evidence.failReceipt = true;
    const runner = new AgentRunner({
      ollama: textOllama(),
      tools: { listDefinitions: () => definitions, execute: vi.fn() },
      evidence,
      runId: () => "run-evidence-failure",
      now: () => new Date("2026-08-28T05:00:00.000Z")
    });
    const handle = runner.start({ message: "Complete." });
    const events: AgentRunEvent[] = [];
    const reader = (async () => {
      try {
        for await (const event of handle.events) {
          events.push(event);
        }
      } catch {
        return;
      }
    })();

    await expect(handle.completion).rejects.toBeInstanceOf(AgentEvidenceError);
    await reader;
    expect(events.map((event) => event.type)).not.toContain("run_completed");
  });
});
