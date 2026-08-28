import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunHandle } from "@unified-ai/agent-runtime";
import {
  AgentRunEventSchema,
  AgentRunReceiptSchema,
  PINNED_OLLAMA_MODEL,
  SCHEMA_VERSION,
  type AgentRunEvent
} from "@unified-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRequestHandler } from "../agui/agent-endpoint.js";
import type { OrchestratorConfig } from "../config.js";
import { errorHandler } from "../errors.js";
import { createCopilotHandler } from "./runtime.js";

const servers: Server[] = [];
const COPILOT_COLD_START_TEST_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

const config: OrchestratorConfig = {
  host: "127.0.0.1",
  port: 8790,
  repositoryRoot: "D:\\Yashu-AI-Workspace\\unified-ai-orchestrator",
  evidenceRoot: "D:\\Yashu-AI-Workspace\\unified-ai-orchestrator\\.local\\evidence",
  trustGrantRelativePath: ".local/trust/workspace-grant.json",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaExecutable: "C:\\Tools\\Ollama\\ollama.exe",
  whiteshadowBaseUrl: "http://127.0.0.1:8787",
  whiteshadowWorkspace: "D:\\whiteshadow-workspace\\local-llm-ws",
  whiteshadowPython: "D:\\whiteshadow-workspace\\local-llm-ws\\.venv\\Scripts\\python.exe",
  webDistRoot: "D:\\Yashu-AI-Workspace\\unified-ai-orchestrator\\apps\\web\\dist"
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.listen(0, "127.0.0.1", resolve);
    probe.once("error", reject);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function successfulHandle(): AgentRunHandle {
  const events = async function* (): AsyncGenerator<AgentRunEvent> {
    yield AgentRunEventSchema.parse({
      runId: "run-through-runtime",
      sequence: 0,
      type: "run_started",
      occurredAt: "2026-08-28T00:00:00.000Z",
      message: "started"
    });
    yield AgentRunEventSchema.parse({
      runId: "run-through-runtime",
      sequence: 1,
      type: "assistant_delta",
      occurredAt: "2026-08-28T00:00:00.100Z",
      message: "Copilot bridge verified."
    });
    yield AgentRunEventSchema.parse({
      runId: "run-through-runtime",
      sequence: 2,
      type: "run_completed",
      occurredAt: "2026-08-28T00:00:01.000Z",
      message: "completed"
    });
  };
  return {
    runId: "run-through-runtime",
    events: events(),
    completion: Promise.resolve(
      AgentRunReceiptSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        runId: "run-through-runtime",
        threadId: "thread-through-runtime",
        messageIds: ["message-through-runtime"],
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
        iterations: 1,
        toolCalls: [],
        inputObjectSha256: "a".repeat(64),
        outputObjectSha256: "b".repeat(64),
        warnings: []
      })
    ),
    cancel: vi.fn()
  };
}

describe("Copilot Runtime bridge", () => {
  it("exposes the v2 discovery endpoint with the default local agent", async () => {
    const app = express();
    app.use(express.json());
    app.use(await createCopilotHandler(config));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/copilotkit/info`
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(text).toContain("default");
    expect(text).not.toMatch(/authorization|x-unified-ai-never-forward/iu);
  }, COPILOT_COLD_START_TEST_TIMEOUT_MS);

  it("streams an agent run end to end and forwards no inbound credentials", async () => {
    const port = await freePort();
    const testConfig = { ...config, port };
    const app = express();
    app.use(express.json());
    let forwardedAuthorization: string | undefined;
    app.use("/api/agent", (request, _response, next) => {
      forwardedAuthorization = request.headers.authorization;
      next();
    });
    app.post(
      "/api/agent",
      createAgentRequestHandler({ start: vi.fn(() => successfulHandle()) })
    );
    app.use(await createCopilotHandler(testConfig));
    app.use(errorHandler);
    const server = app.listen(port, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/copilotkit/agent/default/run`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: "Bearer must-not-forward"
        },
        body: JSON.stringify({
          threadId: "thread-bridge",
          runId: "agui-bridge",
          messages: [
            { id: "user-bridge", role: "user", content: "Verify the bridge" }
          ],
          tools: [],
          context: []
        })
      }
    );
    const stream = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(stream).toContain("RUN_STARTED");
    expect(stream).toContain("Copilot bridge verified.");
    expect(stream).toContain("RUN_FINISHED");
    expect(forwardedAuthorization).toBeUndefined();
    expect(stream).not.toContain("must-not-forward");
  }, COPILOT_COLD_START_TEST_TIMEOUT_MS);

  it(
    "forces telemetry off before constructing the runtime",
    async () => {
      process.env.COPILOTKIT_TELEMETRY_DISABLED = "false";
      process.env.DO_NOT_TRACK = "0";
      await createCopilotHandler(config);
      expect(process.env.COPILOTKIT_TELEMETRY_DISABLED).toBe("true");
      expect(process.env.DO_NOT_TRACK).toBe("1");
    },
    COPILOT_COLD_START_TEST_TIMEOUT_MS
  );
});
