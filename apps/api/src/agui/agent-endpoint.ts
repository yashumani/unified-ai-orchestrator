import type { AgentRunHandle } from "@unified-ai/agent-runtime";
import type { AgentRunRequest } from "@unified-ai/contracts";
import {
  EventType,
  RunAgentInputSchema,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
  type BaseEvent,
  type RunAgentInput
} from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { createHash, randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { ApiError } from "../errors.js";

const MAX_TOOL_ARGUMENT_CHARACTERS = 64_000;
const MAX_TOOL_SUMMARY_CHARACTERS = 2_000;

export interface AgentEndpointPort {
  start(
    request: AgentRunRequest,
    options?: { signal?: AbortSignal }
  ): AgentRunHandle;
}

function messageText(message: RunAgentInput["messages"][number]): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            typeof part.text === "string"
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
  }
  return "";
}

function privateStableId(prefix: string, value: string): string {
  return `${prefix}-${sha256(value).slice(0, 24)}`;
}

function conversationMessages(
  input: RunAgentInput
): NonNullable<AgentRunRequest["messages"]> {
  const selected: NonNullable<AgentRunRequest["messages"]> = [];
  let characters = 0;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const content = messageText(message).slice(0, 20_000);
    if (content.length === 0 || characters + content.length > 80_000) {
      continue;
    }
    const externalId =
      "id" in message && typeof message.id === "string"
        ? message.id
        : `${String(index)}:${message.role}:${content}`;
    selected.push({
      messageId: privateStableId("message", externalId),
      role: message.role,
      content
    });
    characters += content.length;
    if (selected.length >= 32) {
      break;
    }
  }
  selected.reverse();
  if (selected.length > 0 && selected.at(-1)?.role === "user") {
    return selected;
  }
  throw new ApiError(
    400,
    "invalid_request",
    "An AG-UI run requires a non-empty text user message."
  );
}

function boundedJson(value: unknown, limit: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= limit) {
    return serialized;
  }
  return JSON.stringify({
    truncated: true,
    preview: serialized.slice(0, limit)
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function argumentRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeToolArguments(toolName: string, value: unknown): Record<string, unknown> {
  const argumentsRecord = argumentRecord(value);
  const base: Record<string, unknown> = {};
  const path = argumentsRecord["path"];
  if (typeof path === "string") {
    base["pathCharacters"] = path.length;
    base["pathSha256"] = sha256(path);
  }
  if (toolName === "repository.write_file") {
    const content = typeof argumentsRecord["content"] === "string"
      ? argumentsRecord["content"]
      : "";
    return {
      ...base,
      contentBytes: Buffer.byteLength(content, "utf8"),
      contentSha256: sha256(content),
      hasExpectedSha256: typeof argumentsRecord["expectedSha256"] === "string"
    };
  }
  if (toolName === "repository.replace_text") {
    const search = typeof argumentsRecord["search"] === "string"
      ? argumentsRecord["search"]
      : "";
    const replacement = typeof argumentsRecord["replacement"] === "string"
      ? argumentsRecord["replacement"]
      : "";
    return {
      ...base,
      searchCharacters: search.length,
      searchSha256: sha256(search),
      replacementCharacters: replacement.length,
      replacementSha256: sha256(replacement),
      expectedOccurrences: argumentsRecord["expectedOccurrences"],
      hasExpectedSha256: typeof argumentsRecord["expectedSha256"] === "string"
    };
  }
  const safe: Record<string, unknown> = { ...base };
  for (const key of ["query", "prefix", "script"]) {
    const item = argumentsRecord[key];
    if (typeof item === "string") {
      safe[`${key}Characters`] = item.length;
      safe[`${key}Sha256`] = sha256(item);
    }
  }
  for (const key of ["startLine", "lineCount", "limit", "caseSensitive"]) {
    const item = argumentsRecord[key];
    if (typeof item === "number" || typeof item === "boolean") {
      safe[key] = item;
    }
  }
  return safe;
}

function safeToolResult(event: {
  toolCall?: { callId: string; toolName: string } | undefined;
  toolResult?: {
    ok: boolean;
    summary: string;
    truncated: boolean;
    data?: unknown;
  } | undefined;
}): string {
  const policy =
    typeof event.toolResult?.data === "object" &&
    event.toolResult.data !== null &&
    "policy" in event.toolResult.data &&
    typeof event.toolResult.data.policy === "object" &&
    event.toolResult.data.policy !== null &&
    "code" in event.toolResult.data.policy &&
    typeof event.toolResult.data.policy.code === "string"
      ? event.toolResult.data.policy.code
      : "allowed";

  return boundedJson(
    {
      callId: event.toolCall?.callId,
      toolName: event.toolCall?.toolName,
      ok: event.toolResult?.ok ?? false,
      policy,
      summary: (event.toolResult?.summary ?? "Tool result unavailable.").slice(
        0,
        MAX_TOOL_SUMMARY_CHARACTERS
      ),
      truncated: event.toolResult?.truncated ?? false
    },
    MAX_TOOL_SUMMARY_CHARACTERS + 1_000
  );
}

function writeEvent(response: Response, encoder: EventEncoder, event: BaseEvent): void {
  if (!response.destroyed && !response.writableEnded) {
    response.write(encoder.encodeSSE(event));
  }
}

export function createAgentRequestHandler(agent: AgentEndpointPort): RequestHandler {
  return (request, response, next) => {
    let input: RunAgentInput;
    try {
      input = RunAgentInputSchema.parse(request.body);
    } catch (error) {
      next(error);
      return;
    }

    let messages: NonNullable<AgentRunRequest["messages"]>;
    try {
      messages = conversationMessages(input);
    } catch (error) {
      next(error);
      return;
    }

    const controller = new AbortController();
    let streamFinished = false;
    const abort = (): void => {
      if (!streamFinished) {
        controller.abort();
      }
    };
    request.once("aborted", abort);
    response.once("close", abort);

    let run: AgentRunHandle;
    try {
      run = agent.start(
        {
          runId: privateStableId("agui-run", input.runId),
          threadId: privateStableId("agui-thread", input.threadId),
          messages
        },
        { signal: controller.signal }
      );
    } catch (error) {
      request.off("aborted", abort);
      response.off("close", abort);
      next(error);
      return;
    }
    // Register a rejection observer immediately; the event stream carries the
    // same failure and completion is awaited after the stream is drained.
    void run.completion.catch(() => undefined);

    const encoder = new EventEncoder({ accept: "text/event-stream" });
    response.status(200);
    response.setHeader("content-type", encoder.getContentType());
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.setHeader("x-content-type-options", "nosniff");
    response.flushHeaders();

    const runStarted = RunStartedEventSchema.parse({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
      ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId })
    });
    writeEvent(response, encoder, runStarted);

    void (async () => {
      let openMessageId: string | undefined;
      let lastMessageId: string | undefined;

      const closeMessage = (): void => {
        if (openMessageId === undefined) {
          return;
        }
        writeEvent(
          response,
          encoder,
          TextMessageEndEventSchema.parse({
            type: EventType.TEXT_MESSAGE_END,
            messageId: openMessageId
          })
        );
        lastMessageId = openMessageId;
        openMessageId = undefined;
      };

      try {
        for await (const event of run.events) {
          if (event.type === "assistant_delta" && event.message !== undefined) {
            if (openMessageId === undefined) {
              openMessageId = `message-${randomUUID()}`;
              writeEvent(
                response,
                encoder,
                TextMessageStartEventSchema.parse({
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: openMessageId,
                  role: "assistant"
                })
              );
            }
            writeEvent(
              response,
              encoder,
              TextMessageContentEventSchema.parse({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: openMessageId,
                delta: event.message
              })
            );
          } else if (event.type === "tool_started" && event.toolCall !== undefined) {
            closeMessage();
            writeEvent(
              response,
              encoder,
              ToolCallStartEventSchema.parse({
                type: EventType.TOOL_CALL_START,
                toolCallId: event.toolCall.callId,
                toolCallName: event.toolCall.toolName,
                ...(lastMessageId === undefined ? {} : { parentMessageId: lastMessageId })
              })
            );
            writeEvent(
              response,
              encoder,
              ToolCallArgsEventSchema.parse({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: event.toolCall.callId,
                delta: boundedJson(
                  safeToolArguments(
                    event.toolCall.toolName,
                    event.toolCall.arguments
                  ),
                  MAX_TOOL_ARGUMENT_CHARACTERS
                )
              })
            );
          } else if (
            event.type === "tool_completed" &&
            event.toolCall !== undefined &&
            event.toolResult !== undefined
          ) {
            writeEvent(
              response,
              encoder,
              ToolCallEndEventSchema.parse({
                type: EventType.TOOL_CALL_END,
                toolCallId: event.toolCall.callId
              })
            );
            writeEvent(
              response,
              encoder,
              ToolCallResultEventSchema.parse({
                type: EventType.TOOL_CALL_RESULT,
                messageId: `tool-result-${randomUUID()}`,
                toolCallId: event.toolCall.callId,
                content: safeToolResult(event),
                role: "tool"
              })
            );
          }
        }

        const receipt = await run.completion;
        closeMessage();
        if (receipt.status === "succeeded") {
          writeEvent(
            response,
            encoder,
            RunFinishedEventSchema.parse({
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
              outcome: { type: "success" },
              result: {
                evidenceRunId: receipt.runId,
                status: receipt.status,
                model: receipt.model,
                iterations: receipt.iterations,
                toolCallCount: receipt.toolCalls.length
              }
            })
          );
        } else {
          writeEvent(
            response,
            encoder,
            RunErrorEventSchema.parse({
              type: EventType.RUN_ERROR,
              message: `Agent run ended with status ${receipt.status}.`,
              code: receipt.status
            })
          );
        }
      } catch {
        closeMessage();
        writeEvent(
          response,
          encoder,
          RunErrorEventSchema.parse({
            type: EventType.RUN_ERROR,
            message: "The local agent run failed safely.",
            code: "internal_error"
          })
        );
      } finally {
        streamFinished = true;
        request.off("aborted", abort);
        response.off("close", abort);
        if (!response.writableEnded) {
          response.end();
        }
      }
    })();
  };
}
