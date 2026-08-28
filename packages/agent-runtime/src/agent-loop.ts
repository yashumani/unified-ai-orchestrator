import {
  AgentRunEventSchema,
  AgentRunReceiptSchema,
  AgentRunRequestSchema,
  PINNED_OLLAMA_MODEL,
  PolicyDecisionSchema,
  SCHEMA_VERSION,
  ToolResultSchema,
  type AgentRunEvent,
  type AgentRunReceipt,
  type AgentToolReceipt,
  type OllamaMessage,
  type PolicyErrorCode,
  type ToolCall,
  type ToolDefinition,
  type ToolResult
} from "@unified-ai/contracts";
import type {
  OllamaChatRequest,
  OllamaStreamEvent
} from "@unified-ai/ollama-client";
import { randomUUID } from "node:crypto";
import { AsyncEventStream } from "./event-stream.js";
import { initialMessages, toOllamaTools } from "./prompt.js";

export const MAX_AGENT_ITERATIONS = 8;
export const MAX_AGENT_TOOL_CALLS = 12;
export const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
export const MAX_MODEL_TOOL_RESULT_CHARACTERS = 24_000;

export interface OllamaAgentPort {
  streamChat(
    request: OllamaChatRequest,
    signal?: AbortSignal
  ): AsyncIterable<OllamaStreamEvent>;
}

export interface RepositoryToolPort {
  listDefinitions(): ToolDefinition[];
  execute(call: ToolCall): Promise<ToolResult>;
}

export interface StoredEvidenceObject {
  sha256: string;
  relativePath: string;
}

export interface AgentEvidencePort {
  putObject(value: unknown): Promise<StoredEvidenceObject>;
  putAgentRunReceipt(receipt: AgentRunReceipt): Promise<StoredEvidenceObject>;
}

export interface AgentRunnerOptions {
  ollama: OllamaAgentPort;
  tools: RepositoryToolPort;
  evidence: AgentEvidencePort;
  timeoutMs?: number;
  now?: () => Date;
  runId?: () => string;
}

export interface StartAgentRunOptions {
  signal?: AbortSignal;
}

export interface AgentRunHandle {
  runId: string;
  events: AsyncIterable<AgentRunEvent>;
  completion: Promise<AgentRunReceipt>;
  cancel: () => void;
}

export class AgentEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEvidenceError";
  }
}

interface RunContext {
  runId: string;
  startedAt: string;
  inputObjectSha256: string;
  events: AsyncEventStream<AgentRunEvent>;
  signal: AbortSignal;
  timedOut: () => boolean;
  nextSequence: () => number;
  iterations: number;
  toolReceipts: AgentToolReceipt[];
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 1_000);
  }
  return "Agent run failed.";
}

function policyCode(result: ToolResult): PolicyErrorCode {
  if (typeof result.data !== "object" || result.data === null) {
    return "allowed";
  }
  const policy = (result.data as { policy?: unknown }).policy;
  const parsed = PolicyDecisionSchema.safeParse(policy);
  return parsed.success ? parsed.data.code : "allowed";
}

function toolOutcome(
  result: ToolResult,
  code: PolicyErrorCode
): AgentToolReceipt["outcome"] {
  if (code !== "allowed") {
    return "blocked";
  }
  return result.ok ? "succeeded" : "failed";
}

function assistantToolMessage(
  content: string,
  calls: readonly ToolCall[]
): OllamaMessage {
  return {
    role: "assistant",
    content,
    tool_calls: calls.map((call) => ({
      function: { name: call.toolName, arguments: call.arguments }
    }))
  };
}

function modelToolResult(result: ToolResult): string {
  const serialized = JSON.stringify(result);
  if (serialized.length <= MAX_MODEL_TOOL_RESULT_CHARACTERS) {
    return serialized;
  }
  return JSON.stringify({
    callId: result.callId,
    toolName: result.toolName,
    ok: result.ok,
    summary: result.summary,
    truncated: true,
    data: {
      notice: "Tool output exceeded the model-visible limit. Request a narrower read or search.",
      preview: serialized.slice(0, MAX_MODEL_TOOL_RESULT_CHARACTERS)
    }
  });
}

export class AgentRunner {
  readonly #ollama: OllamaAgentPort;
  readonly #tools: RepositoryToolPort;
  readonly #evidence: AgentEvidencePort;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #runId: () => string;

  constructor(options: AgentRunnerOptions) {
    this.#ollama = options.ollama;
    this.#tools = options.tools;
    this.#evidence = options.evidence;
    this.#timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS, 600_000)
    );
    this.#now = options.now ?? (() => new Date());
    this.#runId = options.runId ?? (() => `run-${randomUUID()}`);
  }

  start(rawRequest: { runId?: string | undefined; message: string }, options: StartAgentRunOptions = {}): AgentRunHandle {
    const request = AgentRunRequestSchema.parse(rawRequest);
    const runId = request.runId ?? this.#runId();
    const events = new AsyncEventStream<AgentRunEvent>();
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => controller.abort();
    if (options.signal?.aborted === true) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    timer.unref?.();

    const completion = this.#execute(runId, request.message, events, controller.signal, () => timedOut)
      .then((receipt) => {
        events.close();
        return receipt;
      })
      .catch((error: unknown) => {
        events.fail(error);
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onCallerAbort);
      });

    return {
      runId,
      events,
      completion,
      cancel: () => controller.abort()
    };
  }

  async #execute(
    runId: string,
    userMessage: string,
    events: AsyncEventStream<AgentRunEvent>,
    signal: AbortSignal,
    timedOut: () => boolean
  ): Promise<AgentRunReceipt> {
    const startedAt = this.#now().toISOString();
    const input = await this.#evidence.putObject({
      schemaVersion: SCHEMA_VERSION,
      kind: "agent-run-input",
      runId,
      model: PINNED_OLLAMA_MODEL,
      startedAt,
      message: userMessage
    });
    let sequence = 0;
    const context: RunContext = {
      runId,
      startedAt,
      inputObjectSha256: input.sha256,
      events,
      signal,
      timedOut,
      nextSequence: () => sequence++,
      iterations: 0,
      toolReceipts: []
    };
    this.#emit(context, "run_started", { message: "Agent run started." });

    try {
      return await this.#runLoop(context, userMessage);
    } catch (error) {
      if (error instanceof AgentEvidenceError) {
        throw error;
      }
      const cancelled = signal.aborted && !timedOut();
      const status = cancelled ? "cancelled" : timedOut() ? "stopped" : "failed";
      const warning = timedOut()
        ? "Agent run exceeded the bounded timeout."
        : safeErrorMessage(error);
      const receipt = await this.#persistReceipt(context, {
        status,
        iterations: context.iterations,
        toolCalls: context.toolReceipts,
        warnings: [warning]
      });
      this.#emit(
        context,
        cancelled ? "run_cancelled" : timedOut() ? "run_stopped" : "run_failed",
        { message: warning }
      );
      return receipt;
    }
  }

  async #runLoop(context: RunContext, userMessage: string): Promise<AgentRunReceipt> {
    const messages = initialMessages(userMessage);
    const tools = toOllamaTools(this.#tools.listDefinitions());
    let toolCallCount = 0;

    while (context.iterations < MAX_AGENT_ITERATIONS) {
      if (context.signal.aborted) {
        throw new Error(context.timedOut() ? "Agent run timed out." : "Agent run was cancelled.");
      }
      context.iterations += 1;
      let assistantContent = "";
      const pendingCalls: ToolCall[] = [];
      let streamCompleted = false;

      for await (const event of this.#ollama.streamChat({ messages, tools }, context.signal)) {
        if (event.type === "content") {
          assistantContent += event.content;
          this.#emit(context, "assistant_delta", { message: event.content });
        } else if (event.type === "tool_call") {
          toolCallCount += 1;
          pendingCalls.push({
            callId: `${context.runId}-tool-${toolCallCount}`,
            toolName: event.toolCall.name,
            arguments: event.toolCall.arguments
          });
        } else if (event.type === "complete") {
          streamCompleted = true;
        }
      }

      if (!streamCompleted) {
        throw new Error("Ollama stream ended without completion metadata.");
      }
      if (pendingCalls.length === 0) {
        if (assistantContent.trim().length === 0) {
          throw new Error("Ollama completed without assistant content or a tool call.");
        }
        const output = await this.#evidence.putObject({
          schemaVersion: SCHEMA_VERSION,
          kind: "agent-run-output",
          runId: context.runId,
          completedAt: this.#now().toISOString(),
          content: assistantContent
        });
        const receipt = await this.#persistReceipt(context, {
          status: "succeeded",
          iterations: context.iterations,
          toolCalls: context.toolReceipts,
          outputObjectSha256: output.sha256,
          warnings: []
        });
        this.#emit(context, "run_completed", { message: "Agent run completed with immutable evidence." });
        return receipt;
      }

      if (toolCallCount > MAX_AGENT_TOOL_CALLS) {
        const receipt = await this.#persistReceipt(context, {
          status: "stopped",
          iterations: context.iterations,
          toolCalls: context.toolReceipts,
          warnings: [`Agent requested more than ${MAX_AGENT_TOOL_CALLS} tools.`]
        });
        this.#emit(context, "run_stopped", { message: `Tool-call limit ${MAX_AGENT_TOOL_CALLS} reached.` });
        return receipt;
      }

      messages.push(assistantToolMessage(assistantContent, pendingCalls));
      for (const call of pendingCalls) {
        if (context.signal.aborted) {
          throw new Error(context.timedOut() ? "Agent run timed out." : "Agent run was cancelled.");
        }
        this.#emit(context, "tool_started", { toolCall: call });
        const result = ToolResultSchema.parse(await this.#tools.execute(call));
        const resultObject = await this.#evidence.putObject({
          schemaVersion: SCHEMA_VERSION,
          kind: "agent-tool-result",
          runId: context.runId,
          result
        });
        const code = policyCode(result);
        context.toolReceipts.push({
          callId: call.callId,
          toolName: call.toolName,
          policyCode: code,
          outcome: toolOutcome(result, code),
          resultObjectSha256: resultObject.sha256
        });
        this.#emit(context, "tool_completed", { toolCall: call, toolResult: result });
        messages.push({
          role: "tool",
          tool_name: call.toolName,
          content: modelToolResult(result)
        });
      }
    }

    const receipt = await this.#persistReceipt(context, {
      status: "stopped",
      iterations: MAX_AGENT_ITERATIONS,
      toolCalls: context.toolReceipts,
      warnings: [`Agent reached the ${MAX_AGENT_ITERATIONS}-iteration limit.`]
    });
    this.#emit(context, "run_stopped", { message: `Iteration limit ${MAX_AGENT_ITERATIONS} reached.` });
    return receipt;
  }

  #emit(
    context: RunContext,
    type: AgentRunEvent["type"],
    fields: Pick<AgentRunEvent, "message" | "toolCall" | "toolResult">
  ): void {
    const event = AgentRunEventSchema.parse({
      runId: context.runId,
      sequence: context.nextSequence(),
      type,
      occurredAt: this.#now().toISOString(),
      ...fields
    });
    context.events.push(event);
  }

  async #persistReceipt(
    context: RunContext,
    fields: {
      status: AgentRunReceipt["status"];
      iterations: number;
      toolCalls: AgentToolReceipt[];
      outputObjectSha256?: string | undefined;
      warnings: string[];
    }
  ): Promise<AgentRunReceipt> {
    const receipt = AgentRunReceiptSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      runId: context.runId,
      status: fields.status,
      model: PINNED_OLLAMA_MODEL,
      startedAt: context.startedAt,
      completedAt: this.#now().toISOString(),
      iterations: fields.iterations,
      toolCalls: fields.toolCalls,
      inputObjectSha256: context.inputObjectSha256,
      ...(fields.outputObjectSha256 === undefined
        ? {}
        : { outputObjectSha256: fields.outputObjectSha256 }),
      warnings: fields.warnings
    });
    try {
      await this.#evidence.putAgentRunReceipt(receipt);
    } catch {
      throw new AgentEvidenceError(
        "Agent run receipt could not be persisted; completion was not reported."
      );
    }
    return receipt;
  }
}
