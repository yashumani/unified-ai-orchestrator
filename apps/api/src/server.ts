import type { Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import {
  CANONICAL_REPOSITORY_ROOT,
  loadOptionalEnvironmentFile,
  readConfig,
  type OrchestratorConfig
} from "./config.js";

export async function startServer(config: OrchestratorConfig): Promise<Server> {
  const app = await createApp({ config });
  return await new Promise<Server>((resolveServer, reject) => {
    const server = app.listen(config.port, config.host, () => resolveServer(server));
    server.once("error", reject);
  });
}

export async function closeServer(
  server: Server,
  timeoutMs: number = 10_000
): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      server.closeAllConnections();
      rejectClose(new Error(`Server did not close within ${String(timeoutMs)}ms.`));
    }, timeoutMs);
    timer.unref();
    server.close((error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

export function installGracefulShutdown(
  server: Server,
  timeoutMs: number = 10_000
): () => void {
  let stopping = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stdout.write(
      `${JSON.stringify({ event: "shutdown_started", signal, at: new Date().toISOString() })}\n`
    );
    void closeServer(server, timeoutMs)
      .then(() => {
        process.stdout.write(
          `${JSON.stringify({ event: "shutdown_completed", at: new Date().toISOString() })}\n`
        );
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown shutdown failure";
        process.stderr.write(
          `${JSON.stringify({
            event: "shutdown_failed",
            at: new Date().toISOString(),
            message: message.slice(0, 500)
          })}\n`
        );
        process.exitCode = 1;
      });
  };
  const onSigint = (): void => handleSignal("SIGINT");
  const onSigterm = (): void => handleSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

async function main(): Promise<void> {
  loadOptionalEnvironmentFile(CANONICAL_REPOSITORY_ROOT);
  const config = readConfig(process.env, CANONICAL_REPOSITORY_ROOT);
  const server = await startServer(config);
  installGracefulShutdown(server);
  const host = config.host === "::1" ? "[::1]" : config.host;
  process.stdout.write(`${JSON.stringify({
    event: "server_started",
    at: new Date().toISOString(),
    endpoint: `http://${host}:${String(config.port)}`,
    releaseSha: config.releaseSha ?? "development",
    pid: process.pid
  })}\n`);
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  pathToFileURL(resolve(entry)).href === import.meta.url
) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown startup failure";
    process.stderr.write(`Orchestrator startup failed: ${message.slice(0, 1_000)}\n`);
    process.exitCode = 1;
  });
}
