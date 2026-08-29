import cors from "cors";
import express, { type Express, type RequestHandler } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentRequestHandler } from "./agui/agent-endpoint.js";
import type { OrchestratorConfig } from "./config.js";
import { isLoopbackHostname } from "./config.js";
import type { OrchestratorServices } from "./composition.js";
import { createServices } from "./composition.js";
import { errorEnvelope, errorHandler, notFoundHandler } from "./errors.js";
import { createApiRouter } from "./routes.js";

export interface CreateAppOptions {
  config: OrchestratorConfig;
  services?: OrchestratorServices;
  mountCopilotRuntime?: boolean;
  serveWeb?: boolean;
}

function hostGuard(): RequestHandler {
  return (request, response, next) => {
    const host = request.headers.host;
    if (host === undefined) {
      response
        .status(400)
        .json(errorEnvelope("invalid_request", "A loopback Host header is required.", false));
      return;
    }
    try {
      if (!isLoopbackHostname(new URL(`http://${host}`).hostname)) {
        response
          .status(403)
          .json(errorEnvelope("policy_blocked", "Only loopback requests are accepted.", false));
        return;
      }
    } catch {
      response
        .status(400)
        .json(errorEnvelope("invalid_request", "The Host header is invalid.", false));
      return;
    }
    next();
  };
}

function allowedBrowserOrigin(config: OrchestratorConfig, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const allowedPorts = new Set([String(config.port), "4311"]);
  return (
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname) &&
    allowedPorts.has(url.port || "80") &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}

function loopbackCorsOrigin(config: OrchestratorConfig) {
  return (
    origin: string | undefined,
    callback: (error: Error | null, allow?: boolean) => void
  ): void => {
  if (origin === undefined) {
    callback(null, true);
    return;
  }
    callback(null, allowedBrowserOrigin(config, origin));
  };
}

function mutationRequestGuard(config: OrchestratorConfig): RequestHandler {
  return (request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      next();
      return;
    }
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      fetchSite === "cross-site" ||
      (origin !== undefined && !allowedBrowserOrigin(config, origin))
    ) {
      response
        .status(403)
        .json(errorEnvelope("policy_blocked", "Cross-origin state changes are blocked.", false));
      return;
    }
    if (!request.is(["application/json", "application/*+json"])) {
      response
        .status(415)
        .json(errorEnvelope("invalid_request", "State-changing requests require JSON.", false));
      return;
    }
    next();
  };
}

export async function createApp(options: CreateAppOptions): Promise<Express> {
  const services = options.services ?? (await createServices(options.config));
  const app = express();
  app.disable("x-powered-by");
  app.use(hostGuard());
  app.use(
    cors({
      origin: loopbackCorsOrigin(options.config),
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["content-type", "accept"],
      credentials: false,
      maxAge: 600
    })
  );
  app.use(mutationRequestGuard(options.config));
  app.use(
    "/api/portfolio/chat-imports",
    express.json({
      limit: "25mb",
      type: ["application/json", "application/*+json"]
    })
  );
  app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));

  app.post("/api/agent", createAgentRequestHandler(services.agent));
  app.use("/api", createApiRouter(services));
  if (options.mountCopilotRuntime !== false) {
    const { createCopilotHandler } = await import("./copilot/runtime.js");
    app.use(await createCopilotHandler(options.config));
  }

  if (options.serveWeb !== false) {
    const indexPath = resolve(options.config.webDistRoot, "index.html");
    if (existsSync(indexPath)) {
      app.use(express.static(options.config.webDistRoot, { index: false }));
      app.get(/^(?!\/api(?:\/|$)).*/u, (_request, response) => {
        response.sendFile(indexPath);
      });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
