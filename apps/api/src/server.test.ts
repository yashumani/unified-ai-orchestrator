import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, installGracefulShutdown } from "./server.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      if (server.listening) {
        await closeServer(server);
      }
    })
  );
});

async function listen(): Promise<ReturnType<typeof createServer>> {
  const server = createServer((_request, response) => response.end("ok"));
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
    server.once("error", rejectListen);
  });
  return server;
}

describe("server lifecycle", () => {
  it("closes a listening server within the deployment timeout", async () => {
    const server = await listen();
    expect(server.listening).toBe(true);

    await closeServer(server, 1_000);

    expect(server.listening).toBe(false);
  });

  it("installs removable SIGINT and SIGTERM handlers", async () => {
    const server = await listen();
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    const remove = installGracefulShutdown(server, 1_000);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);

    remove();
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });
});
