import { invalidResponse } from "./errors.js";

const DEFAULT_MAX_RECORD_CHARACTERS = 10_000_000;

export interface NdjsonParserOptions<T> {
  readonly parse?: (value: unknown) => T;
  readonly maxRecordCharacters?: number;
}

function parseRecord<T>(
  record: string,
  parser: ((value: unknown) => T) | undefined
): T {
  let value: unknown;
  try {
    value = JSON.parse(record) as unknown;
  } catch {
    throw invalidResponse("Ollama returned malformed NDJSON.");
  }

  if (parser === undefined) {
    return value as T;
  }

  try {
    return parser(value);
  } catch {
    throw invalidResponse("Ollama returned an invalid NDJSON record.");
  }
}

/** Parse UTF-8 NDJSON without assuming network chunks align with lines or code points. */
export async function* parseNdjson<T = unknown>(
  stream: ReadableStream<Uint8Array>,
  options: NdjsonParserOptions<T> = {}
): AsyncGenerator<T> {
  const maxRecordCharacters =
    options.maxRecordCharacters ?? DEFAULT_MAX_RECORD_CHARACTERS;
  if (!Number.isSafeInteger(maxRecordCharacters) || maxRecordCharacters <= 0) {
    throw new TypeError("maxRecordCharacters must be a positive safe integer.");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";

  const append = (value: string): void => {
    buffer += value;
  };

  const assertRecordSize = (value: string): void => {
    if (value.length > maxRecordCharacters) {
      throw invalidResponse("Ollama returned an oversized NDJSON record.");
    }
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      try {
        append(decoder.decode(result.value, { stream: true }));
      } catch (error) {
        if (error instanceof Error && error.name === "OllamaClientError") {
          throw error;
        }
        throw invalidResponse("Ollama returned invalid UTF-8.");
      }

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawRecord = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const record = rawRecord.endsWith("\r")
          ? rawRecord.slice(0, -1)
          : rawRecord;
        assertRecordSize(record);
        if (record.trim().length > 0) {
          yield parseRecord(record, options.parse);
        }
        newlineIndex = buffer.indexOf("\n");
      }
      assertRecordSize(buffer);
    }

    try {
      append(decoder.decode());
    } catch (error) {
      if (error instanceof Error && error.name === "OllamaClientError") {
        throw error;
      }
      throw invalidResponse("Ollama returned invalid UTF-8.");
    }

    const finalRecord = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    assertRecordSize(finalRecord);
    if (finalRecord.trim().length > 0) {
      yield parseRecord(finalRecord, options.parse);
    }
  } finally {
    reader.releaseLock();
  }
}
