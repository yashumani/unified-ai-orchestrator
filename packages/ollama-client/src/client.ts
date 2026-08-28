import {
  OllamaChatChunkSchema,
  PINNED_OLLAMA_MODEL,
  type OllamaMessage,
  type RepositoryToolName
} from "@unified-ai/contracts";

import { OllamaClientError, invalidResponse } from "./errors.js";
import { parseNdjson } from "./ndjson.js";

export { PINNED_OLLAMA_MODEL };

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_KEEP_ALIVE = "5m";
export const DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS = 30_000;
export const OLLAMA_CONTEXT_SIZE = 4096;
export const OLLAMA_TEMPERATURE = 0.2;

const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_KEEP_ALIVE_MILLISECONDS = 3_600_000;

export type OllamaFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface OllamaClientOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly keepAlive?: string | number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: OllamaFetch;
}

export interface OllamaHealth {
  readonly reachable: true;
  readonly version: string;
}

export interface OllamaModelInventory {
  readonly models: string[];
  readonly pinnedModel: typeof PINNED_OLLAMA_MODEL;
  readonly pinnedModelAvailable: boolean;
}

export interface OllamaProbe {
  readonly health: OllamaHealth;
  readonly inventory: OllamaModelInventory;
}

export interface OllamaToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: RepositoryToolName;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface OllamaChatRequest {
  readonly messages: readonly OllamaMessage[];
  readonly tools?: readonly OllamaToolDefinition[];
}

export interface NormalizedOllamaToolCall {
  readonly name: RepositoryToolName;
  readonly arguments: Record<string, unknown>;
}

export interface OllamaCompletionMetadata {
  readonly model: typeof PINNED_OLLAMA_MODEL;
  readonly createdAt: string;
  readonly doneReason?: string;
  readonly totalDuration?: number;
  readonly loadDuration?: number;
  readonly promptEvalCount?: number;
  readonly promptEvalDuration?: number;
  readonly evalCount?: number;
  readonly evalDuration?: number;
}

export type OllamaStreamEvent =
  | { readonly type: "content"; readonly content: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | {
      readonly type: "tool_call";
      readonly toolCall: NormalizedOllamaToolCall;
    }
  | {
      readonly type: "complete";
      readonly metadata: OllamaCompletionMetadata;
    };

interface RequestScope {
  readonly signal: AbortSignal;
  readonly callerAborted: () => boolean;
  readonly timedOut: () => boolean;
  readonly close: () => void;
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

function configurationError(message: string): OllamaClientError {
  return new OllamaClientError("invalid_configuration", message, {
    retryable: false
  });
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("Ollama base URL must be a valid HTTP URL.");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw configurationError(
      "Ollama base URL must be credential-free loopback HTTP without a path, query, or fragment."
    );
  }

  return url.toString().replace(/\/$/u, "");
}

function validateRequestTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw configurationError(
      `Ollama request timeout must be between 1 and ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`
    );
  }
  return value;
}

function durationToMilliseconds(value: string): number | undefined {
  const match = /^(0|[1-9]\d*)(ms|s|m|h)$/u.exec(value);
  if (match === null) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}

function validateKeepAlive(value: string | number): string | number {
  const duration =
    typeof value === "number" ? value * 1_000 : durationToMilliseconds(value);
  if (
    duration === undefined ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    duration > MAX_KEEP_ALIVE_MILLISECONDS
  ) {
    throw configurationError(
      "Ollama keep-alive must be a bounded duration no greater than one hour."
    );
  }
  return value;
}

function createRequestScope(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined
): RequestScope {
  const controller = new AbortController();
  let timeoutReached = false;
  let abortedByCaller = callerSignal?.aborted ?? false;

  const onCallerAbort = (): void => {
    abortedByCaller = true;
    controller.abort();
  };
  if (callerSignal?.aborted === true) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    callerAborted: () => abortedByCaller,
    timedOut: () => timeoutReached,
    close: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };
}

function mapRequestError(error: unknown, scope: RequestScope): OllamaClientError {
  if (error instanceof OllamaClientError) {
    return error;
  }
  if (scope.callerAborted()) {
    return new OllamaClientError("aborted", "Ollama request was cancelled.", {
      retryable: false
    });
  }
  if (scope.timedOut()) {
    return new OllamaClientError(
      "request_timeout",
      "Ollama request exceeded its configured timeout.",
      { retryable: true }
    );
  }
  return new OllamaClientError(
    "runtime_offline",
    "Ollama is unavailable at the configured endpoint.",
    { retryable: true }
  );
}

function assertSuccessful(response: Response): void {
  if (response.ok) {
    return;
  }

  throw new OllamaClientError(
    "upstream_error",
    `Ollama returned HTTP ${response.status}.`,
    {
      retryable: response.status === 429 || response.status >= 500,
      status: response.status
    }
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw invalidResponse("Ollama returned invalid JSON.");
  }
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function optionalNonNegativeInteger(
  record: UnknownRecord,
  key: string
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResponse("Ollama returned invalid completion metadata.");
  }
  return value as number;
}

function completionMetadata(
  raw: unknown,
  model: string,
  createdAt: string,
  doneReason: string | undefined
): OllamaCompletionMetadata {
  if (model !== PINNED_OLLAMA_MODEL) {
    throw new OllamaClientError(
      "model_mismatch",
      "Ollama responded with a model other than the pinned model.",
      { retryable: false }
    );
  }
  const record = asRecord(raw);
  if (record === undefined) {
    throw invalidResponse("Ollama returned an invalid chat chunk.");
  }

  const metadata = {
    model: PINNED_OLLAMA_MODEL,
    createdAt,
    ...(doneReason === undefined ? {} : { doneReason }),
    ...optionalMetadata(record, "total_duration", "totalDuration"),
    ...optionalMetadata(record, "load_duration", "loadDuration"),
    ...optionalMetadata(record, "prompt_eval_count", "promptEvalCount"),
    ...optionalMetadata(
      record,
      "prompt_eval_duration",
      "promptEvalDuration"
    ),
    ...optionalMetadata(record, "eval_count", "evalCount"),
    ...optionalMetadata(record, "eval_duration", "evalDuration")
  } satisfies OllamaCompletionMetadata;
  return metadata;
}

function optionalMetadata<K extends keyof OllamaCompletionMetadata>(
  record: UnknownRecord,
  rawKey: string,
  normalizedKey: K
): Partial<Pick<OllamaCompletionMetadata, K>> {
  const value = optionalNonNegativeInteger(record, rawKey);
  return value === undefined
    ? {}
    : ({ [normalizedKey]: value } as Partial<
        Pick<OllamaCompletionMetadata, K>
      >);
}

export class OllamaClient {
  readonly baseUrl: string;
  readonly model = PINNED_OLLAMA_MODEL;
  readonly keepAlive: string | number;
  readonly requestTimeoutMs: number;

  readonly #fetch: OllamaFetch;

  constructor(options: OllamaClientOptions = {}) {
    const model = options.model ?? PINNED_OLLAMA_MODEL;
    if (model !== PINNED_OLLAMA_MODEL) {
      throw new OllamaClientError(
        "model_mismatch",
        `Phase 1 requires the exact Ollama model ${PINNED_OLLAMA_MODEL}.`,
        { retryable: false }
      );
    }

    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL
    );
    this.keepAlive = validateKeepAlive(
      options.keepAlive ?? DEFAULT_OLLAMA_KEEP_ALIVE
    );
    this.requestTimeoutMs = validateRequestTimeout(
      options.requestTimeoutMs ?? DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS
    );
    this.#fetch = options.fetch ?? fetch;
  }

  async probeHealth(signal?: AbortSignal): Promise<OllamaHealth> {
    return await this.#withRequest(signal, async (requestSignal) => {
      const response = await this.#fetch(`${this.baseUrl}/api/version`, {
        method: "GET",
        signal: requestSignal
      });
      assertSuccessful(response);
      const record = asRecord(await readJson(response));
      const version = record?.["version"];
      if (typeof version !== "string" || version.trim().length === 0) {
        throw invalidResponse("Ollama returned an invalid version response.");
      }
      return { reachable: true, version };
    });
  }

  async probeModelInventory(
    signal?: AbortSignal
  ): Promise<OllamaModelInventory> {
    return await this.#withRequest(signal, async (requestSignal) => {
      const response = await this.#fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: requestSignal
      });
      assertSuccessful(response);
      const record = asRecord(await readJson(response));
      const rawModels = record?.["models"];
      if (!Array.isArray(rawModels)) {
        throw invalidResponse("Ollama returned an invalid model inventory.");
      }

      const models: string[] = [];
      for (const rawModel of rawModels) {
        const modelRecord = asRecord(rawModel);
        const name = modelRecord?.["name"] ?? modelRecord?.["model"];
        if (typeof name !== "string" || name.trim().length === 0) {
          throw invalidResponse("Ollama returned an invalid model inventory.");
        }
        if (!models.includes(name)) {
          models.push(name);
        }
      }

      return {
        models,
        pinnedModel: PINNED_OLLAMA_MODEL,
        pinnedModelAvailable: models.includes(PINNED_OLLAMA_MODEL)
      };
    });
  }

  async probe(signal?: AbortSignal): Promise<OllamaProbe> {
    const health = await this.probeHealth(signal);
    const inventory = await this.probeModelInventory(signal);
    return { health, inventory };
  }

  async requirePinnedModel(signal?: AbortSignal): Promise<OllamaModelInventory> {
    const inventory = await this.probeModelInventory(signal);
    if (!inventory.pinnedModelAvailable) {
      throw new OllamaClientError(
        "model_missing",
        `The pinned Ollama model ${PINNED_OLLAMA_MODEL} is not installed.`,
        { retryable: false }
      );
    }
    return inventory;
  }

  async *streamChat(
    request: OllamaChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<OllamaStreamEvent> {
    const scope = createRequestScope(this.requestTimeoutMs, signal);
    let completed = false;

    try {
      if (scope.callerAborted()) {
        throw new OllamaClientError(
          "aborted",
          "Ollama request was cancelled.",
          { retryable: false }
        );
      }

      const body = JSON.stringify({
        model: PINNED_OLLAMA_MODEL,
        messages: request.messages,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        stream: true,
        think: false,
        keep_alive: this.keepAlive,
        options: {
          num_ctx: OLLAMA_CONTEXT_SIZE,
          temperature: OLLAMA_TEMPERATURE
        }
      });
      const response = await this.#fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: scope.signal
      });
      assertSuccessful(response);
      if (response.body === null) {
        throw invalidResponse("Ollama returned an empty streaming response.");
      }

      for await (const raw of parseNdjson(response.body)) {
        if (completed) {
          throw invalidResponse(
            "Ollama returned data after the completion record."
          );
        }
        const parsed = OllamaChatChunkSchema.safeParse(raw);
        if (!parsed.success) {
          throw invalidResponse("Ollama returned an invalid chat chunk.");
        }
        const chunk = parsed.data;
        if (chunk.model !== PINNED_OLLAMA_MODEL) {
          throw new OllamaClientError(
            "model_mismatch",
            "Ollama responded with a model other than the pinned model.",
            { retryable: false }
          );
        }

        if (chunk.message.content.length > 0) {
          yield { type: "content", content: chunk.message.content };
        }
        if (
          chunk.message.thinking !== undefined &&
          chunk.message.thinking.length > 0
        ) {
          yield { type: "thinking", thinking: chunk.message.thinking };
        }
        for (const toolCall of chunk.message.tool_calls ?? []) {
          yield {
            type: "tool_call",
            toolCall: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments
            }
          };
        }

        if (chunk.done) {
          completed = true;
          yield {
            type: "complete",
            metadata: completionMetadata(
              raw,
              chunk.model,
              chunk.created_at,
              chunk.done_reason
            )
          };
        }
      }

      if (!completed) {
        throw invalidResponse(
          "Ollama ended the stream before a completion record."
        );
      }
    } catch (error) {
      throw mapRequestError(error, scope);
    } finally {
      scope.close();
    }
  }

  async #withRequest<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const scope = createRequestScope(this.requestTimeoutMs, callerSignal);
    try {
      if (scope.callerAborted()) {
        throw new OllamaClientError(
          "aborted",
          "Ollama request was cancelled.",
          { retryable: false }
        );
      }
      return await operation(scope.signal);
    } catch (error) {
      throw mapRequestError(error, scope);
    } finally {
      scope.close();
    }
  }
}
