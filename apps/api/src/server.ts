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

async function main(): Promise<void> {
  loadOptionalEnvironmentFile(CANONICAL_REPOSITORY_ROOT);
  const config = readConfig(process.env, CANONICAL_REPOSITORY_ROOT);
  await startServer(config);
  const host = config.host === "::1" ? "[::1]" : config.host;
  process.stdout.write(
    `Unified AI Orchestrator listening at http://${host}:${config.port}\n`
  );
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
