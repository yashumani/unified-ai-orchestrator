import {
  PINNED_OLLAMA_MODEL,
  RuntimeStatusSchema,
  TrustStateSchema
} from "@unified-ai/contracts";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorConfig } from "./config.js";
import type { OrchestratorServices } from "./composition.js";

const servers: Server[] = [];

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

const runtimeStatus = RuntimeStatusSchema.parse({
  model: PINNED_OLLAMA_MODEL,
  ollama: {
    service: "ollama",
    phase: "ready",
    endpoint: "http://127.0.0.1:11434/",
    checkedAt: "2026-08-28T00:00:00.000Z",
    detail: "Ollama is ready.",
    model: PINNED_OLLAMA_MODEL
  },
  whiteshadow: {
    service: "whiteshadow",
    phase: "degraded",
    endpoint: "http://127.0.0.1:8787/",
    checkedAt: "2026-08-28T00:00:00.000Z",
    detail: "WhiteShadow is offline."
  }
});

const trustState = TrustStateSchema.parse({
  trusted: false,
  identity: {
    repositoryRoot: config.repositoryRoot,
    origin: "https://github.com/yashumani/unified-ai-orchestrator.git",
    originSha256: "a".repeat(64),
    branch: "feature/ollama-orchestration",
    protectedBranch: false
  },
  grant: null,
  reason: "No active persistent workspace grant exists."
});

const safeCapability = {
  capabilityId: "health",
  name: "Health",
  description: "Read the localhost WhiteShadow web service health summary.",
  risk: "safe" as const,
  modelUse: "none" as const,
  mode: "read" as const
};

function services(overrides: Partial<OrchestratorServices> = {}): OrchestratorServices {
  return {
    config,
    runtime: {
      status: vi.fn(async () => runtimeStatus),
      start: vi.fn(async () => runtimeStatus)
    },
    policy: {
      getTrustState: vi.fn(async () => trustState),
      grantWorkspaceTrust: vi.fn(async () => trustState),
      revokeWorkspaceTrust: vi.fn(async () => trustState)
    },
    whiteshadow: {
      status: vi.fn(async () => runtimeStatus.whiteshadow),
      listCapabilities: vi.fn(() => [safeCapability]),
      invoke: vi.fn()
    },
    evidence: {
      listAgentRunReceipts: vi.fn(async () => []),
      readAgentRunReceipt: vi.fn()
    },
    portfolio: {
      startRun: vi.fn(() => ({
        runId: "portfolio-run-fixture",
        status: "queued",
        createdAt: "2026-08-29T00:00:00.000Z",
        repositoryCount: 0,
        completeCount: 0,
        incompleteCount: 0,
        warningCount: 0,
        warnings: [],
        revisionMismatchCount: 0
      })),
      listRuns: vi.fn(() => []),
      getRun: vi.fn(),
      listRepositories: vi.fn(() => []),
      getRepository: vi.fn(),
      listClusters: vi.fn(() => []),
      getCluster: vi.fn(),
      listRecommendations: vi.fn(() => []),
      getRecommendation: vi.fn(),
      overrideRecommendation: vi.fn(),
      importChat: vi.fn(async () => ({
        importedCount: 1,
        receiptId: "receipt-chat-fixture",
        receiptIds: ["receipt-chat-fixture"]
      }))
    },
    agent: { start: vi.fn() },
    ollama: {},
    tools: {},
    ...overrides
  } as unknown as OrchestratorServices;
}

async function startLocal(
  configuredServices: OrchestratorServices
): Promise<string> {
  const app = await createApp({
    config,
    services: configuredServices,
    mountCopilotRuntime: false,
    serveWeb: false
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function rawGetWithHost(
  url: string,
  hostHeader: string
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "GET",
        headers: { host: hostHeader }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    request.once("error", reject);
    request.end();
  });
}

describe("local API", () => {
  it("exposes health, runtime start, trust, capabilities, and receipt summaries", async () => {
    const baseUrl = await startLocal(services());
    const health = await fetch(`${baseUrl}/api/health`);
    expect(await health.json()).toEqual({
      status: "ok",
      app: "unified-ai-orchestrator",
      mode: "local",
      model: PINNED_OLLAMA_MODEL
    });

    const runtime = await fetch(`${baseUrl}/api/runtime/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(await runtime.json()).toEqual(runtimeStatus);

    const trust = await fetch(`${baseUrl}/api/trust`);
    expect(await trust.json()).toEqual(trustState);

    const capabilities = await fetch(`${baseUrl}/api/whiteshadow/capabilities`);
    expect(await capabilities.json()).toEqual({
      available: false,
      status: runtimeStatus.whiteshadow,
      capabilities: []
    });

    const runs = await fetch(`${baseUrl}/api/runs?limit=12`);
    expect(await runs.json()).toEqual({ runs: [] });
  });

  it("advertises WhiteShadow capabilities only after the live adapter is ready", async () => {
    const readyStatus = {
      ...runtimeStatus.whiteshadow,
      phase: "ready" as const,
      detail: "WhiteShadow model-free read adapter is ready."
    };
    const configured = services({
      whiteshadow: {
        status: vi.fn(async () => readyStatus),
        listCapabilities: vi.fn(() => [safeCapability]),
        invoke: vi.fn()
      } as unknown as OrchestratorServices["whiteshadow"]
    });
    const baseUrl = await startLocal(configured);
    const response = await fetch(`${baseUrl}/api/whiteshadow/capabilities`);
    expect(await response.json()).toEqual({
      available: true,
      status: readyStatus,
      capabilities: [safeCapability]
    });
  });

  it("blocks a non-loopback Host header", async () => {
    const baseUrl = await startLocal(services());
    const response = await rawGetWithHost(
      `${baseUrl}/api/health`,
      "attacker.example"
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: "policy_blocked",
        message: "Only loopback requests are accepted.",
        retryable: false
      }
    });
  });

  it.each([
    ["https://attacker.example", "application/x-www-form-urlencoded"],
    ["http://127.0.0.1:9999", "application/json"]
  ])("blocks hostile state-changing origin %s", async (origin, contentType) => {
    const configured = services();
    const baseUrl = await startLocal(configured);
    const response = await fetch(`${baseUrl}/api/runtime/start`, {
      method: "POST",
      headers: {
        origin,
        "content-type": contentType,
        "sec-fetch-site": "cross-site"
      },
      body: contentType === "application/json" ? "{}" : "action=start"
    });
    expect(response.status).toBe(403);
    expect(configured.runtime.start).not.toHaveBeenCalled();
  });

  it("rejects form POSTs even when Origin is absent", async () => {
    const configured = services();
    const baseUrl = await startLocal(configured);
    const response = await fetch(`${baseUrl}/api/trust/grant`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant=yes"
    });
    expect(response.status).toBe(415);
    expect(configured.policy.grantWorkspaceTrust).not.toHaveBeenCalled();
  });

  it("allows loopback browser preflight for dashboard draft PUT requests", async () => {
    const baseUrl = await startLocal(services());
    const response = await fetch(`${baseUrl}/api/dashboard-builder/templates/sample/draft`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:4311",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("maps oversized JSON to a safe 413 response", async () => {
    const configured = services();
    const baseUrl = await startLocal(configured);
    const response = await fetch(`${baseUrl}/api/runtime/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_100_000) })
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "The JSON request exceeds the 1 MiB limit.",
        retryable: false
      }
    });
    expect(configured.runtime.start).not.toHaveBeenCalled();
  });

  it("returns a stable error envelope without exposing exception details", async () => {
    const configured = services({
      runtime: {
        status: vi.fn(async () => {
          throw new Error("secret internal failure");
        }),
        start: vi.fn(async () => runtimeStatus)
      } as unknown as OrchestratorServices["runtime"]
    });
    const baseUrl = await startLocal(configured);
    const response = await fetch(`${baseUrl}/api/runtime/status`);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("secret internal failure");
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "internal_error",
        message: "The local orchestrator request failed safely.",
        retryable: false
      }
    });
  });

  it("does not expose any credential fields in health output", async () => {
    const baseUrl = await startLocal(services());
    const response = await fetch(`${baseUrl}/api/health`);
    const text = await response.text();
    expect(text).not.toMatch(/token|password|secret|ghp_/iu);
    expect(text).toContain(PINNED_OLLAMA_MODEL);
  });

  it("exposes explicit portfolio refresh and sanitized read routes", async () => {
    const configured = services();
    const baseUrl = await startLocal(configured);
    const refresh = await fetch(`${baseUrl}/api/portfolio/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(refresh.status).toBe(202);
    expect(await refresh.json()).toMatchObject({
      runId: "portfolio-run-fixture",
      status: "queued"
    });
    expect(configured.portfolio.startRun).toHaveBeenCalledOnce();

    await expect(
      (await fetch(`${baseUrl}/api/portfolio/repositories`)).json()
    ).resolves.toEqual({ items: [] });
    await expect(
      (await fetch(`${baseUrl}/api/portfolio/clusters`)).json()
    ).resolves.toEqual({ items: [] });
    await expect(
      (await fetch(`${baseUrl}/api/portfolio/recommendations`)).json()
    ).resolves.toEqual({ items: [] });
  });

  it("accepts a bounded large ChatGPT export only on its dedicated JSON route", async () => {
    const configured = services();
    const baseUrl = await startLocal(configured);
    const conversations = [
      {
        id: "conversation-fixture",
        title: "Synthetic export",
        padding: "x".repeat(1_100_000)
      }
    ];
    const response = await fetch(`${baseUrl}/api/portfolio/chat-imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "app-development",
        conversations
      })
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      importedCount: 1,
      receiptId: "receipt-chat-fixture"
    });
    expect(configured.portfolio.importChat).toHaveBeenCalledOnce();
  });
});
