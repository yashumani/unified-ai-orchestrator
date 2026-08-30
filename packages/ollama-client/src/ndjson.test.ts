import { describe, expect, it } from "vitest";

import { OllamaClientError } from "./errors.js";
import { parseNdjson } from "./ndjson.js";
import { byteChunks, streamFromChunks } from "./__fixtures__/chat-streams.js";

describe("parseNdjson", () => {
  it("parses CRLF records split across arbitrary UTF-8 byte boundaries", async () => {
    const input = '{"text":"first"}\r\n{"text":"world 🌍"}\r\n';
    const globeStart = new TextEncoder().encode(input).indexOf(0xf0);
    const stream = streamFromChunks(
      byteChunks(input, [1, 5, 18, globeStart + 1, globeStart + 3])
    );

    const records: unknown[] = [];
    for await (const record of parseNdjson(stream)) {
      records.push(record);
    }

    expect(records).toEqual([
      { text: "first" },
      { text: "world 🌍" }
    ]);
  });

  it("parses the final record when the stream has no trailing newline", async () => {
    const stream = streamFromChunks(
      byteChunks('{"sequence":1}\n{"sequence":2}', [3, 14, 17])
    );

    const records: unknown[] = [];
    for await (const record of parseNdjson(stream)) {
      records.push(record);
    }

    expect(records).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  });

  it("applies the size limit to each record rather than the whole byte chunk", async () => {
    const stream = streamFromChunks([
      new TextEncoder().encode('{"v":1}\n{"v":2}\n')
    ]);

    const records: unknown[] = [];
    for await (const record of parseNdjson(stream, { maxRecordCharacters: 7 })) {
      records.push(record);
    }

    expect(records).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it("returns a sanitized typed error for malformed records", async () => {
    const secret = "TOP-SECRET-PROMPT";
    const stream = streamFromChunks([
      new TextEncoder().encode(`{"content":"${secret}"`)
    ]);

    let caught: unknown;
    try {
      for await (const _record of parseNdjson(stream)) {
        // The parser fails before producing a record.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OllamaClientError);
    expect(caught).toMatchObject({ code: "invalid_response", retryable: false });
    expect((caught as Error).message).not.toContain(secret);
  });
});
