import type { AgentRunHandle } from "@unified-ai/agent-runtime";
import {
  AgentRunEventSchema,
  AgentRunReceiptSchema,
  PINNED_OLLAMA_MODEL,
  SCHEMA_VERSION,
  type AgentRunEvent
} from "@unified-ai/contracts";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRequestHandler, type AgentEndpointPort } from "./agent-endpoint.js";
import { errorHandler } from "../errors.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

function event(
  sequence: number,
  type: AgentRunEvent["type"],
  fields: Partial<Pick<AgentRunEvent, "message" | "toolCall" | "toolResult">> = {}
): AgentRunEvent {
  return AgentRunEventSchema.parse({
    runId: "run-local",
    sequence,
    type,
    occurredAt: new Date(sequence * 1_000).toISOString(),
    ...fields
  });
}

async function* events(): AsyncGenerator<AgentRunEvent> {
  yield event(0, "run_started", { message: "started" });
  yield event(1, "assistant_delta", { message: "Checking " });
  yield event(2, "tool_started", {
    toolCall: {
      callId: "run-local-tool-1",
      toolName: "repository.write_file",
      arguments: {
        path: "sources/fixtures/example.txt",
        content: "browser-must-not-see-this-content"
      }
    }
  });
  yield event(3, "tool_completed", {
    toolCall: {
      callId: "run-local-tool-1",
      toolName: "repository.write_file",
      arguments: {
        path: "sources/fixtures/example.txt",
        content: "browser-must-not-see-this-content"
      }
    },
    toolResult: {
      callId: "run-local-tool-1",
      toolName: "repository.write_file",
      ok: true,
      summary: "repository.git_status completed.",
      data: { secret: "must-not-cross-the-API" },
      truncated: false
    }
  });
  yield event(4, "tool_started", {
    toolCall: {
      callId: "run-local-tool-2",
      toolName: "repository.search",
      arguments: {
        query: "browser-must-not-see-this-query",
        prefix: "browser-must-not-see-this-prefix"
      }
    }
  });
  yield event(5, "tool_completed", {
    toolCall: {
      callId: "run-local-tool-2",
      toolName: "repository.search",
      arguments: {
        query: "browser-must-not-see-this-query",
        prefix: "browser-must-not-see-this-prefix"
      }
    },
    toolResult: {
      callId: "run-local-tool-2",
      toolName: "repository.search",
      ok: true,
      summary: "repository.search completed.",
      truncated: false
    }
  });
  yield event(6, "assistant_delta", { message: "done." });
  yield event(7, "run_completed", { message: "completed" });
}

function successfulHandle(): AgentRunHandle {
  return {
    runId: "run-local",
    events: events(),
    completion: Promise.resolve(
      AgentRunReceiptSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        runId: "run-local",
        threadId: "thread-local",
        messageIds: ["message-local"],
        status: "succeeded",
        model: PINNED_OLLAMA_MODEL,
        runtime: { contextSize: 4096, temperature: 0.2, thinking: false },
        toolSchemaObjectSha256: "c".repeat(64),
        workspace: {
          repositoryRootSha256: "d".repeat(64),
          originSha256: "e".repeat(64),
          branch: "feature/test"
        },
        startedAt: "2026-08-28T00:00:00.000Z",
        completedAt: "2026-08-28T00:00:01.000Z",
        iterations: 2,
        toolCalls: [],
        inputObjectSha256: "a".repeat(64),
        outputObjectSha256: "b".repeat(64),
        warnings: []
      })
    ),
    cancel: vi.fn()
  };
}

async function start(agent: AgentEndpointPort): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post("/api/agent", createAgentRequestHandler(agent));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function parseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("AG-UI agent endpoint", () => {
  it("streams balanced messages, ordered tools, and one terminal receipt result", async () => {
    const startRun = vi.fn(() => successfulHandle());
    const baseUrl = await start({ start: startRun });
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        threadId: "thread-1",
        runId: "agui-run-1",
        messages: [
          { id: "user-previous", role: "user", content: "What did we inspect?" },
          { id: "assistant-previous", role: "assistant", content: "We inspected policy." },
          { id: "user-1", role: "user", content: "Inspect status" }
        ],
        tools: [],
        context: []
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();
    const parsed = parseEvents(stream);
    expect(parsed.map((item) => item["type"])).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED"
    ]);
    expect(parsed.filter((item) => item["type"] === "RUN_FINISHED")).toHaveLength(1);
    expect(stream).not.toContain("must-not-cross-the-API");
    expect(stream).not.toContain("browser-must-not-see-this-content");
    expect(stream).not.toContain("sources/fixtures/example.txt");
    expect(stream).not.toContain("browser-must-not-see-this-query");
    expect(stream).not.toContain("browser-must-not-see-this-prefix");
    expect(stream).toContain("contentSha256");
    expect(stream).toContain("pathSha256");
    expect(stream).toContain("querySha256");
    expect(stream).toContain("prefixSha256");
    expect(startRun).toHaveBeenCalledWith(
      {
        runId: expect.stringMatching(/^agui-run-[a-f0-9]{24}$/u),
        threadId: expect.stringMatching(/^agui-thread-[a-f0-9]{24}$/u),
        messages: [
          {
            messageId: expect.stringMatching(/^message-[a-f0-9]{24}$/u),
            role: "user",
            content: "What did we inspect?"
          },
          {
            messageId: expect.stringMatching(/^message-[a-f0-9]{24}$/u),
            role: "assistant",
            content: "We inspected policy."
          },
          {
            messageId: expect.stringMatching(/^message-[a-f0-9]{24}$/u),
            role: "user",
            content: "Inspect status"
          }
        ]
      },
      { signal: expect.any(AbortSignal) }
    );
  });

  it("rejects a run without a text user message before opening SSE", async () => {
    const baseUrl = await start({ start: vi.fn(() => successfulHandle()) });
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-1",
        runId: "agui-run-1",
        messages: [],
        tools: [],
        context: []
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "An AG-UI run requires a non-empty text user message.",
        retryable: false
      }
    });
  });
});
