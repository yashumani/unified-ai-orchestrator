import { describe, expect, it } from "vitest";

import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_KEEP_ALIVE,
  OllamaClient,
  OllamaClientError,
  PINNED_OLLAMA_MODEL,
  type OllamaFetch,
  type OllamaStreamEvent
} from "./index.js";
import {
  STREAM_WITHOUT_TRAILING_NEWLINE,
  byteChunks,
  streamFromChunks
} from "./__fixtures__/chat-streams.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function collectEvents(
  events: AsyncIterable<OllamaStreamEvent>
): Promise<OllamaStreamEvent[]> {
  const collected: OllamaStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("OllamaClient configuration", () => {
  it("pins the only accepted model to qwen3:4b", () => {
    expect(PINNED_OLLAMA_MODEL).toBe("qwen3:4b");
    expect(
      () => new OllamaClient({ model: "qwen3:8b", fetch: fetch })
    ).toThrowError(OllamaClientError);
  });

  it("rejects an unbounded keep-alive value", () => {
    expect(
      () => new OllamaClient({ keepAlive: "-1", fetch: fetch })
    ).toThrowError(/keep-alive/u);
  });

  it("rejects remote, credentialed, and non-HTTP endpoints", () => {
    expect(() => new OllamaClient({ baseUrl: "http://example.com:11434" })).toThrowError(
      /loopback HTTP/u
    );
    expect(
      () => new OllamaClient({ baseUrl: "http://user:secret@127.0.0.1:11434" })
    ).toThrowError(/loopback HTTP/u);
    expect(() => new OllamaClient({ baseUrl: "https://127.0.0.1:11434" })).toThrowError(
      /loopback HTTP/u
    );
  });
});

describe("OllamaClient probes", () => {
  it("checks health through the version endpoint", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl: OllamaFetch = async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return jsonResponse({ version: "0.32.13" });
    };
    const client = new OllamaClient({ fetch: fetchImpl });

    const health = await client.probeHealth();

    expect(health).toEqual({ reachable: true, version: "0.32.13" });
    expect(requestedUrl).toBe(`${DEFAULT_OLLAMA_BASE_URL}/api/version`);
    expect(requestedInit?.method).toBe("GET");
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("lists models and only accepts the exact pinned inventory name", async () => {
    const fetchImpl: OllamaFetch = async () =>
      jsonResponse({
        models: [
          { name: "qwen3:4b", model: "qwen3:4b", size: 100 },
          { name: "qwen3:4b-latest", model: "qwen3:4b-latest", size: 200 }
        ]
      });
    const client = new OllamaClient({ fetch: fetchImpl });

    await expect(client.probeModelInventory()).resolves.toEqual({
      models: ["qwen3:4b", "qwen3:4b-latest"],
      pinnedModel: "qwen3:4b",
      pinnedModelAvailable: true
    });
  });
});

describe("OllamaClient streaming chat", () => {
  it("sends the fixed safe request and normalizes streamed output", async () => {
    let requestUrl = "";
    let requestMethod: string | undefined;
    let requestBody: unknown;
    const fetchImpl: OllamaFetch = async (input, init) => {
      requestUrl = String(input);
      requestMethod = init?.method;
      requestBody = JSON.parse(String(init?.body));
      const chunks = byteChunks(STREAM_WITHOUT_TRAILING_NEWLINE, [
        1,
        9,
        61,
        137,
        241,
        389
      ]);
      return new Response(streamFromChunks(chunks), {
        status: 200,
        headers: { "content-type": "application/x-ndjson" }
      });
    };
    const client = new OllamaClient({ fetch: fetchImpl });

    const events = await collectEvents(
      client.streamChat({
        messages: [{ role: "user", content: "Inspect this repository" }],
        tools: [
          {
            type: "function",
            function: {
              name: "repository.read_file",
              description: "Read a repository file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
              }
            }
          }
        ]
      })
    );

    expect(requestUrl).toBe(`${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
    expect(requestMethod).toBe("POST");
    expect(requestBody).toEqual({
      model: "qwen3:4b",
      messages: [{ role: "user", content: "Inspect this repository" }],
      tools: [
        {
          type: "function",
          function: {
            name: "repository.read_file",
            description: "Read a repository file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"]
            }
          }
        }
      ],
      stream: true,
      think: false,
      keep_alive: DEFAULT_OLLAMA_KEEP_ALIVE,
      options: { num_ctx: 4096, temperature: 0.2 }
    });
    expect(events).toEqual([
      { type: "content", content: "Hello " },
      { type: "thinking", thinking: "checking" },
      { type: "content", content: "world 🌍" },
      {
        type: "tool_call",
        toolCall: {
          name: "repository.read_file",
          arguments: { path: "README.md" }
        }
      },
      {
        type: "tool_call",
        toolCall: {
          name: "repository.search",
          arguments: { query: "orchestrator" }
        }
      },
      {
        type: "complete",
        metadata: {
          model: "qwen3:4b",
          createdAt: "2026-08-28T10:00:00.200Z",
          doneReason: "stop",
          totalDuration: 1200,
          loadDuration: 100,
          promptEvalCount: 11,
          promptEvalDuration: 200,
          evalCount: 7,
          evalDuration: 900
        }
      }
    ]);
  });

  it("rejects a successful HTTP response that has no stream body", async () => {
    const fetchImpl: OllamaFetch = async () =>
      new Response(null, { status: 200 });
    const client = new OllamaClient({ fetch: fetchImpl });

    await expect(
      collectEvents(client.streamChat({ messages: [] }))
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("does not expose an upstream response body in its error", async () => {
    const secret = "PRIVATE-RESPONSE-BODY";
    const fetchImpl: OllamaFetch = async () =>
      new Response(secret, { status: 503 });
    const client = new OllamaClient({ fetch: fetchImpl });

    let caught: unknown;
    try {
      await collectEvents(client.streamChat({ messages: [] }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "upstream_error",
      status: 503,
      retryable: true
    });
    expect((caught as Error).message).not.toContain(secret);
  });

  it("classifies caller cancellation separately from request timeout", async () => {
    const waitForAbort: OllamaFetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    const client = new OllamaClient({
      fetch: waitForAbort,
      requestTimeoutMs: 10
    });

    await expect(
      collectEvents(client.streamChat({ messages: [] }))
    ).rejects.toMatchObject({ code: "request_timeout", retryable: true });

    const controller = new AbortController();
    controller.abort();
    await expect(
      collectEvents(client.streamChat({ messages: [] }, controller.signal))
    ).rejects.toMatchObject({ code: "aborted", retryable: false });
  });
});
