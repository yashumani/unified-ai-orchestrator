import {
  AgentRunEventSchema,
  AgentRunReceiptSchema,
  AgentRunRequestSchema,
  PINNED_OLLAMA_MODEL,
  PolicyDecisionSchema,
  SCHEMA_VERSION,
  ToolResultSchema,
  type AgentConversationMessage,
  type AgentRunEvent,
  type AgentRunReceipt,
  type AgentToolReceipt,
  type AgentUsage,
  type AgentWorkspaceEvidence,
  type OllamaMessage,
  type PolicyDecision,
  type ToolCall,
  type ToolDefinition,
  type ToolResult
} from "@unified-ai/contracts";
import {
  OLLAMA_CONTEXT_SIZE,
  OLLAMA_TEMPERATURE,
  type OllamaChatRequest,
  type OllamaCompletionMetadata,
  type OllamaStreamEvent
} from "@unified-ai/ollama-client";
import { createHash, randomUUID } from "node:crypto";
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
  execute(
    call: ToolCall,
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult>;
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
  workspaceContext?: () => Promise<AgentWorkspaceEvidence>;
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
  threadId: string;
  messageIds: string[];
  startedAt: string;
  inputObjectSha256: string;
  toolSchemaObjectSha256: string;
  workspace: AgentWorkspaceEvidence;
  usage: AgentUsage;
  events: AsyncEventStream<AgentRunEvent>;
  signal: AbortSignal;
  timedOut: () => boolean;
  nextSequence: () => number;
  iterations: number;
  toolReceipts: AgentToolReceipt[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value) ?? "undefined");
}

function fallbackWorkspaceContext(): AgentWorkspaceEvidence {
  return {
    repositoryRootSha256: sha256("workspace-unavailable"),
    originSha256: sha256("origin-unavailable"),
    branch: "unavailable"
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Agent operation was cancelled.";
  }
  return "Agent run failed safely.";
}

function policyDecision(result: ToolResult, checkedAt: string): PolicyDecision {
  if (typeof result.data === "object" && result.data !== null) {
    const parsed = PolicyDecisionSchema.safeParse(
      (result.data as { policy?: unknown }).policy
    );
    if (parsed.success) {
      return parsed.data;
    }
  }
  return PolicyDecisionSchema.parse({
    allowed: true,
    code: "allowed",
    reason: "The fixed catalog classifies this as a read-only repository tool.",
    checkedAt
  });
}

function toolOutcome(
  result: ToolResult,
  decision: PolicyDecision
): AgentToolReceipt["outcome"] {
  if (!decision.allowed) {
    return "blocked";
  }
  return result.ok ? "succeeded" : "failed";
}

function argumentRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeArgumentEvidence(call: ToolCall): Record<string, unknown> {
  const source = argumentRecord(call.arguments);
  const safe: Record<string, unknown> = {
    shape: typeof call.arguments,
    keyCount: Object.keys(source).length
  };
  for (const key of [
    "path",
    "prefix",
    "query",
    "script",
    "content",
    "search",
    "replacement"
  ]) {
    const item = source[key];
    if (typeof item === "string") {
      safe[`${key}Characters`] = item.length;
      safe[`${key}Sha256`] = sha256(item);
    }
  }
  for (const key of [
    "startLine",
    "lineCount",
    "limit",
    "caseSensitive",
    "expectedOccurrences"
  ]) {
    const item = source[key];
    if (typeof item === "number" || typeof item === "boolean") {
      safe[key] = item;
    }
  }
  if (typeof source["expectedSha256"] === "string") {
    safe["hasExpectedSha256"] = true;
  }
  return safe;
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
      payloadSha256: sha256(serialized)
    }
  });
}

function accumulateUsage(
  usage: AgentUsage,
  metadata: OllamaCompletionMetadata
): AgentUsage {
  const result: AgentUsage = { ...usage };
  let reported = false;
  for (const key of [
    "totalDuration",
    "loadDuration",
    "promptEvalCount",
    "promptEvalDuration",
    "evalCount",
    "evalDuration"
  ] as const) {
    const value = metadata[key];
    if (value !== undefined) {
      reported = true;
      result[key] = (result[key] ?? 0) + value;
    }
  }
  result.available = usage.available || reported;
  return result;
}

function normalizeConversation(
  request: ReturnType<typeof AgentRunRequestSchema.parse>,
  runId: string
): { threadId: string; messages: AgentConversationMessage[] } {
  if (request.messages !== undefined) {
    return {
      threadId: request.threadId ?? `thread-${runId}`,
      messages: request.messages
    };
  }
  const content = request.message as string;
  return {
    threadId: request.threadId ?? `thread-${runId}`,
    messages: [
      {
        messageId: `message-${sha256(content).slice(0, 24)}`,
        role: "user",
        content
      }
    ]
  };
}

export class AgentRunner {
  readonly #ollama: OllamaAgentPort;
  readonly #tools: RepositoryToolPort;
  readonly #evidence: AgentEvidencePort;
  readonly #workspaceContext: () => Promise<AgentWorkspaceEvidence>;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #runId: () => string;

  constructor(options: AgentRunnerOptions) {
    this.#ollama = options.ollama;
    this.#tools = options.tools;
    this.#evidence = options.evidence;
    this.#workspaceContext =
      options.workspaceContext ?? (async () => fallbackWorkspaceContext());
    this.#timeoutMs = Math.max(
      1_000,
      Math.min(options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS, 600_000)
    );
    this.#now = options.now ?? (() => new Date());
    this.#runId = options.runId ?? (() => `run-${randomUUID()}`);
  }

  start(
    rawRequest: Parameters<typeof AgentRunRequestSchema.parse>[0],
    options: StartAgentRunOptions = {}
  ): AgentRunHandle {
    const request = AgentRunRequestSchema.parse(rawRequest);
    const runId = request.runId ?? this.#runId();
    const conversation = normalizeConversation(request, runId);
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

    const completion = this.#execute(
      runId,
      conversation.threadId,
      conversation.messages,
      events,
      controller.signal,
      () => timedOut
    )
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
    threadId: string,
    conversation: AgentConversationMessage[],
    events: AsyncEventStream<AgentRunEvent>,
    signal: AbortSignal,
    timedOut: () => boolean
  ): Promise<AgentRunReceipt> {
    const startedAt = this.#now().toISOString();
    const definitions = this.#tools.listDefinitions();
    const [input, toolSchema, workspace] = await Promise.all([
      this.#evidence.putObject({
        schemaVersion: SCHEMA_VERSION,
        kind: "agent-run-input-metadata",
        runId,
        threadId,
        model: PINNED_OLLAMA_MODEL,
        startedAt,
        messages: conversation.map((message) => ({
          messageId: message.messageId,
          role: message.role,
          contentSha256: sha256(message.content),
          contentCharacters: message.content.length
        }))
      }),
      this.#evidence.putObject({
        schemaVersion: SCHEMA_VERSION,
        kind: "agent-tool-schema",
        definitions
      }),
      this.#workspaceContext()
    ]);
    let sequence = 0;
    const context: RunContext = {
      runId,
      threadId,
      messageIds: conversation.map((message) => message.messageId),
      startedAt,
      inputObjectSha256: input.sha256,
      toolSchemaObjectSha256: toolSchema.sha256,
      workspace,
      usage: { available: false },
      events,
      signal,
      timedOut,
      nextSequence: () => sequence++,
      iterations: 0,
      toolReceipts: []
    };
    this.#emit(context, "run_started", { message: "Agent run started." });

    try {
      return await this.#runLoop(context, conversation, definitions);
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

  async #runLoop(
    context: RunContext,
    conversation: AgentConversationMessage[],
    definitions: ToolDefinition[]
  ): Promise<AgentRunReceipt> {
    const messages = initialMessages(conversation);
    const tools = toOllamaTools(definitions);
    let toolCallCount = 0;

    while (context.iterations < MAX_AGENT_ITERATIONS) {
      if (context.signal.aborted) {
        throw new DOMException("Agent run was cancelled.", "AbortError");
      }
      context.iterations += 1;
      let assistantContent = "";
      const pendingCalls: ToolCall[] = [];
      let streamCompleted = false;

      for await (const event of this.#ollama.streamChat(
        { messages, tools },
        context.signal
      )) {
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
          context.usage = accumulateUsage(context.usage, event.metadata);
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
          kind: "agent-run-output-metadata",
          runId: context.runId,
          completedAt: this.#now().toISOString(),
          contentSha256: sha256(assistantContent),
          contentCharacters: assistantContent.length
        });
        const receipt = await this.#persistReceipt(context, {
          status: "succeeded",
          iterations: context.iterations,
          toolCalls: context.toolReceipts,
          outputObjectSha256: output.sha256,
          warnings: []
        });
        this.#emit(context, "run_completed", {
          message: "Agent run completed with immutable evidence."
        });
        return receipt;
      }

      if (toolCallCount > MAX_AGENT_TOOL_CALLS) {
        const receipt = await this.#persistReceipt(context, {
          status: "stopped",
          iterations: context.iterations,
          toolCalls: context.toolReceipts,
          warnings: [`Agent requested more than ${MAX_AGENT_TOOL_CALLS} tools.`]
        });
        this.#emit(context, "run_stopped", {
          message: `Tool-call limit ${MAX_AGENT_TOOL_CALLS} reached.`
        });
        return receipt;
      }

      messages.push(assistantToolMessage(assistantContent, pendingCalls));
      for (const call of pendingCalls) {
        if (context.signal.aborted) {
          throw new DOMException("Agent run was cancelled.", "AbortError");
        }
        this.#emit(context, "tool_started", { toolCall: call });
        const result = ToolResultSchema.parse(
          await this.#tools.execute(call, { signal: context.signal })
        );
        const checkedAt = this.#now().toISOString();
        const decision = policyDecision(result, checkedAt);
        const [argumentsObject, resultObject] = await Promise.all([
          this.#evidence.putObject({
            schemaVersion: SCHEMA_VERSION,
            kind: "agent-tool-arguments-metadata",
            runId: context.runId,
            callId: call.callId,
            toolName: call.toolName,
            payloadSha256: sha256Json(call.arguments),
            arguments: safeArgumentEvidence(call)
          }),
          this.#evidence.putObject({
            schemaVersion: SCHEMA_VERSION,
            kind: "agent-tool-result-metadata",
            runId: context.runId,
            callId: call.callId,
            toolName: call.toolName,
            ok: result.ok,
            summary: result.summary.slice(0, 2_000),
            policy: decision,
            truncated: result.truncated,
            resultPayloadSha256: sha256Json(result)
          })
        ]);
        context.toolReceipts.push({
          callId: call.callId,
          toolName: call.toolName,
          argumentsObjectSha256: argumentsObject.sha256,
          policyCode: decision.code,
          policyReason: decision.reason.slice(0, 2_000),
          policyCheckedAt: decision.checkedAt,
          outcome: toolOutcome(result, decision),
          resultObjectSha256: resultObject.sha256,
          resultPayloadSha256: sha256Json(result),
          summary: result.summary.slice(0, 2_000)
        });
        this.#emit(context, "tool_completed", {
          toolCall: call,
          toolResult: result
        });
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
    this.#emit(context, "run_stopped", {
      message: `Iteration limit ${MAX_AGENT_ITERATIONS} reached.`
    });
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
      threadId: context.threadId,
      messageIds: context.messageIds,
      status: fields.status,
      model: PINNED_OLLAMA_MODEL,
      runtime: {
        contextSize: OLLAMA_CONTEXT_SIZE,
        temperature: OLLAMA_TEMPERATURE,
        thinking: false
      },
      toolSchemaObjectSha256: context.toolSchemaObjectSha256,
      workspace: context.workspace,
      startedAt: context.startedAt,
      completedAt: this.#now().toISOString(),
      iterations: fields.iterations,
      toolCalls: fields.toolCalls,
      inputObjectSha256: context.inputObjectSha256,
      ...(fields.outputObjectSha256 === undefined
        ? {}
        : { outputObjectSha256: fields.outputObjectSha256 }),
      usage: context.usage,
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
