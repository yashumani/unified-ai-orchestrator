import type { RequestHandler } from "express";
import { once } from "node:events";
import type { OrchestratorConfig } from "../config.js";

function agentUrl(config: OrchestratorConfig): string {
  const host = config.host === "::1" ? "[::1]" : config.host;
  return `http://${host}:${config.port}/api/agent`;
}

function copyRequestHeaders(request: Parameters<RequestHandler>[0]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || (name !== "accept" && name !== "content-type")) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

export async function createCopilotHandler(
  config: OrchestratorConfig
): Promise<RequestHandler> {
  process.env["COPILOTKIT_TELEMETRY_DISABLED"] = "true";
  process.env["DO_NOT_TRACK"] = "1";
  const [{ HttpAgent }, { CopilotRuntime, createCopilotRuntimeHandler }] =
    await Promise.all([
      import("@ag-ui/client"),
      import("@copilotkit/runtime/v2")
    ]);
  const agent = new HttpAgent({
    agentId: "default",
    description: "Governed local repository orchestrator powered by qwen3:4b.",
    url: agentUrl(config)
  });
  const runtime = new CopilotRuntime({
    agents: { default: agent },
    exposeMemoryRoutes: false,
    // A non-empty allowlist activates allowlist mode; subtracting the same
    // sentinel guarantees that no browser header reaches the local agent.
    forwardHeaders: {
      allow: ["x-unified-ai-never-forward"],
      deny: ["x-unified-ai-never-forward"]
    }
  });

  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: "/api/copilotkit",
    mode: "multi-route",
    cors: false,
    activateChannels: false
  });

  return (request, response, next) => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);

    void (async () => {
      const method = request.method.toUpperCase();
      const hasBody = method !== "GET" && method !== "HEAD";
      const contentType = request.headers["content-type"] ?? "";
      if (hasBody && !contentType.toLowerCase().includes("application/json")) {
        throw new Error("Copilot Runtime accepts JSON requests only in Phase 1.");
      }
      const host = request.headers.host;
      if (host === undefined) {
        throw new Error("Copilot Runtime requires a loopback Host header.");
      }
      const webRequest = new Request(`http://${host}${request.originalUrl}`, {
        method,
        headers: copyRequestHeaders(request),
        signal: controller.signal,
        ...(hasBody ? { body: JSON.stringify(request.body ?? {}) } : {})
      });
      const webResponse = await handler(webRequest);
      response.status(webResponse.status);
      webResponse.headers.forEach((value, name) => response.setHeader(name, value));

      if (webResponse.body === null) {
        response.end();
        return;
      }
      const reader = webResponse.body.getReader();
      try {
        while (!response.destroyed && !response.writableEnded) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          if (!response.write(Buffer.from(chunk.value))) {
            await once(response, "drain");
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!response.writableEnded) {
        response.end();
      }
    })()
      .catch(next)
      .finally(() => {
        request.off("aborted", abort);
        response.off("close", abort);
      });
  };
}
