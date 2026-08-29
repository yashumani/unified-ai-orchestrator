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
  it("runs schema-constrained portfolio classification with pinned local settings", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const resultJson = JSON.stringify({
      purpose: "Local AI orchestration",
      action: "keep-standalone",
      rationale: "The stored evidence supports a standalone runtime.",
      citationIds: ["citation-repo-alpha"]
    });
    const fetchImpl: OllamaFetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        `${JSON.stringify({
          model: "qwen3:4b",
          created_at: "2026-08-28T10:00:00.000Z",
          message: { role: "assistant", content: resultJson },
          done: true,
          done_reason: "stop"
        })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    };
    const client = new OllamaClient({ fetch: fetchImpl });
    const format = {
      type: "object",
      properties: {
        purpose: { type: "string" },
        action: { type: "string", enum: ["keep-standalone"] },
        rationale: { type: "string" },
        citationIds: { type: "array", items: { type: "string" } }
      },
      required: ["purpose", "action", "rationale", "citationIds"],
      additionalProperties: false
    };

    const result = await client.structuredChat({
      messages: [{ role: "user", content: "Classify stored evidence." }],
      format,
      maxTokens: 512
    });

    expect(result.value).toEqual(JSON.parse(resultJson));
    expect(requestBodies).toEqual([
      expect.objectContaining({
        model: "qwen3:4b",
        stream: true,
        think: false,
        format,
        options: { num_ctx: 4096, temperature: 0.2, num_predict: 512 }
      })
    ]);
    expect(requestBodies[0]).not.toHaveProperty("tools");
  });

  it("sends the fixed safe text request and normalizes streamed output", async () => {
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
        messages: [{ role: "user", content: "Inspect this repository" }]
      })
    );

    expect(requestUrl).toBe(`${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
    expect(requestMethod).toBe("POST");
    expect(requestBody).toEqual({
      model: "qwen3:4b",
      messages: [{ role: "user", content: "Inspect this repository" }],
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

  it("uses a constrained streaming plan when tools are offered", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const untrustedResponse = "The repository is clean without checking.";
    const plan = JSON.stringify({
      decision: "call_tool",
      toolName: "repository.git_status",
      response: untrustedResponse
    });
    const fetchImpl: OllamaFetch = async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>
      );
      const content = requestBodies.length === 1 ? plan : "{}";
      return new Response(
        [
          JSON.stringify({
            model: "qwen3:4b",
            created_at: "2026-08-28T10:00:00.000Z",
            message: { role: "assistant", content: content.slice(0, 31) },
            done: false
          }),
          JSON.stringify({
            model: "qwen3:4b",
            created_at: "2026-08-28T10:00:00.100Z",
            message: { role: "assistant", content: content.slice(31) },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 115,
            eval_count: 41
          })
        ].join("\n"),
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    };
    const client = new OllamaClient({ fetch: fetchImpl });
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "repository.git_status" as const,
          description: "Read repository status.",
          parameters: { type: "object", properties: {}, additionalProperties: false }
        }
      }
    ];

    const events = await collectEvents(
      client.streamChat({
        messages: [
          { role: "system", content: "Stay inside the repository." },
          { role: "user", content: "Check status." }
        ],
        tools
      })
    );

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).not.toHaveProperty("tools");
    expect(requestBodies[0]).toMatchObject({
      model: "qwen3:4b",
      stream: true,
      think: false,
      options: { num_ctx: 4096, temperature: 0, num_predict: 256 },
      format: {
        type: "object",
        properties: {
          decision: { enum: ["call_tool", "respond"] },
          toolName: { enum: ["repository.git_status", "none"] }
        }
      }
    });
    expect(requestBodies[1]).toMatchObject({
      format: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    });
    expect(
      (requestBodies[0]?.["messages"] as Array<{ content: string }>)[0]?.content
    ).toContain("Offered tools:");
    expect(events).toEqual([
      {
        type: "tool_call",
        toolCall: { name: "repository.git_status", arguments: {} }
      },
      {
        type: "complete",
        metadata: {
          model: "qwen3:4b",
          createdAt: "2026-08-28T10:00:00.100Z",
          doneReason: "stop",
          promptEvalCount: 230,
          evalCount: 82
        }
      }
    ]);
    expect(JSON.stringify(events)).not.toContain(untrustedResponse);
  });

  it("emits bounded response deltas only from a validated respond plan", async () => {
    const responseText =
      "The authoritative tool result reports feature/ollama-orchestration with local changes.";
    const plan = JSON.stringify({
      decision: "respond",
      toolName: "none",
      response: responseText
    });
    const fetchImpl: OllamaFetch = async () =>
      new Response(
        `${JSON.stringify({
          model: "qwen3:4b",
          created_at: "2026-08-28T10:00:00.000Z",
          message: { role: "assistant", content: plan },
          done: true,
          done_reason: "stop"
        })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    const client = new OllamaClient({ fetch: fetchImpl });

    const events = await collectEvents(
      client.streamChat({
        messages: [{ role: "user", content: "Check status." }],
        tools: [
          {
            type: "function",
            function: {
              name: "repository.git_status",
              description: "Read repository status.",
              parameters: { type: "object", properties: {} }
            }
          }
        ]
      })
    );

    expect(
      events
        .filter((event) => event.type === "content")
        .map((event) => event.content)
        .join("")
    ).toBe(responseText);
    expect(events.at(-1)?.type).toBe("complete");
  });

  it("enforces numeric argument bounds and grounds generation with the full tool schema", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const responses = [
      JSON.stringify({
        decision: "call_tool",
        toolName: "repository.read_file",
        response: ""
      }),
      JSON.stringify({ path: "README.md", lineCount: 20 })
    ];
    const fetchImpl: OllamaFetch = async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>
      );
      const content = responses[requestBodies.length - 1] ?? "{}";
      return new Response(
        `${JSON.stringify({
          model: "qwen3:4b",
          created_at: "2026-08-28T10:00:00.000Z",
          message: { role: "assistant", content },
          done: true,
          done_reason: "stop"
        })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    };
    const client = new OllamaClient({ fetch: fetchImpl });

    const events = await collectEvents(
      client.streamChat({
        messages: [{ role: "user", content: "Read README.md with 20 lines." }],
        tools: [
          {
            type: "function",
            function: {
              name: "repository.read_file",
              description: "Read a repository file.",
              parameters: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  lineCount: {
                    type: "integer",
                    minimum: 1,
                    maximum: 1_000,
                    default: 200
                  }
                },
                required: ["path"],
                additionalProperties: false
              }
            }
          }
        ]
      })
    );

    expect(requestBodies[1]).toMatchObject({
      format: {
        properties: {
          lineCount: { type: "integer", minimum: 1, maximum: 1_000 }
        }
      }
    });
    expect(
      (requestBodies[1]?.["messages"] as Array<{ content: string }>)[0]?.content
    ).toContain('"default":200');
    expect(events).toContainEqual({
      type: "tool_call",
      toolCall: {
        name: "repository.read_file",
        arguments: { path: "README.md", lineCount: 20 }
      }
    });
  });

  it("rejects a structured plan that selects an unoffered tool", async () => {
    const plan = JSON.stringify({
      decision: "call_tool",
      toolName: "shell.exec",
      response: ""
    });
    const fetchImpl: OllamaFetch = async () =>
      new Response(
        `${JSON.stringify({
          model: "qwen3:4b",
          created_at: "2026-08-28T10:00:00.000Z",
          message: { role: "assistant", content: plan },
          done: true
        })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    const client = new OllamaClient({ fetch: fetchImpl });

    await expect(
      collectEvents(
        client.streamChat({
          messages: [{ role: "user", content: "Run a shell." }],
          tools: [
            {
              type: "function",
              function: {
                name: "repository.git_status",
                description: "Read repository status.",
                parameters: { type: "object", properties: {} }
              }
            }
          ]
        })
      )
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects a successful HTTP response that has no stream body", async () => {
    const fetchImpl: OllamaFetch = async () =>
      new Response(null, { status: 200 });
    const client = new OllamaClient({ fetch: fetchImpl });

    await expect(
      collectEvents(client.streamChat({ messages: [] }))
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("preserves unknown tool names and malformed argument shapes for policy rejection", async () => {
    const fetchImpl: OllamaFetch = async () =>
      new Response(
        `${JSON.stringify({
          model: "qwen3:4b",
          created_at: "2026-08-28T10:00:00.000Z",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "shell.exec", arguments: "whoami" } }
            ]
          },
          done: true,
          done_reason: "stop"
        })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    const client = new OllamaClient({ fetch: fetchImpl });

    await expect(
      collectEvents(client.streamChat({ messages: [] }))
    ).resolves.toEqual([
      {
        type: "tool_call",
        toolCall: { name: "shell.exec", arguments: "whoami" }
      },
      {
        type: "complete",
        metadata: {
          model: "qwen3:4b",
          createdAt: "2026-08-28T10:00:00.000Z",
          doneReason: "stop"
        }
      }
    ]);
  });

  it("normalizes structurally malformed tool calls into safe rejection requests", async () => {
    const fetchImpl: OllamaFetch = async () =>
      new Response(
        `${JSON.stringify({
          model: "qwen3:4b",
          created_at: "2026-08-28T10:00:00.000Z",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { arguments: { path: "README.md" } } },
              { unexpected: "shape" }
            ]
          },
          done: true,
          done_reason: "stop"
        })}\n`,
        { status: 200, headers: { "content-type": "application/x-ndjson" } }
      );
    const client = new OllamaClient({ fetch: fetchImpl });

    const events = await collectEvents(client.streamChat({ messages: [] }));
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      {
        type: "tool_call",
        toolCall: {
          name: "malformed.tool_call",
          arguments: { classification: "invalid_input", malformed: true }
        }
      },
      {
        type: "tool_call",
        toolCall: {
          name: "malformed.tool_call",
          arguments: { classification: "invalid_input", malformed: true }
        }
      }
    ]);
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
