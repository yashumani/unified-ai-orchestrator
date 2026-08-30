import {
  ConversationSnapshotSchema,
  SCHEMA_VERSION,
  StableIdSchema,
  type ConversationActor,
  type ConversationSnapshot
} from "@unified-ai/contracts";
import {
  canonicalJson,
  sha256Hex,
  type LocalEvidenceStore
} from "@unified-ai/evidence-index";
import {
  ingestConversationSnapshot,
  type ConversationIngestionResult
} from "./normalize-conversation.js";

const SUPPORTED_ACTORS = new Set<ConversationActor>([
  "user",
  "assistant",
  "tool",
  "system"
]);

export interface ChatGptExportOptions {
  projectId?: string;
}

export interface ChatGptExportImportResult {
  snapshots: ConversationSnapshot[];
  ingestions: ConversationIngestionResult[];
}

interface RawMappingNode {
  id?: unknown;
  parent?: unknown;
  message?: unknown;
}

interface RawMessage {
  id?: unknown;
  author?: unknown;
  create_time?: unknown;
  content?: unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function utcTimestamp(value: unknown, label: string): string {
  let timestamp: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    timestamp = value > 10_000_000_000 ? value : value * 1_000;
  } else if (typeof value === "string" && value.trim().length > 0) {
    timestamp = Date.parse(value);
  } else {
    throw new Error(`${label} timestamp is missing or invalid`);
  }

  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return new Date(timestamp).toISOString();
}

function derivedStableId(prefix: string, raw: string): string {
  return StableIdSchema.parse(`${prefix}-${sha256Hex(raw).slice(0, 24)}`);
}

function messageContent(value: unknown): string | null {
  const content = record(value, "ChatGPT message content");
  const parts = content.parts;
  if (!Array.isArray(parts)) {
    throw new Error("ChatGPT message content parts must be an array");
  }
  const text = parts
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return text.length > 0 ? text : null;
}

function actorFromMessage(value: unknown): ConversationActor {
  const author = record(value, "ChatGPT message author");
  const role = nonEmptyString(author.role, "ChatGPT actor") as ConversationActor;
  if (!SUPPORTED_ACTORS.has(role)) {
    throw new Error(`unsupported ChatGPT actor: ${role}`);
  }
  return role;
}

function activeNodes(
  mapping: Record<string, RawMappingNode>,
  currentNode: unknown
): RawMappingNode[] {
  if (typeof currentNode === "string" && currentNode.length > 0) {
    const result: RawMappingNode[] = [];
    const visited = new Set<string>();
    let cursor: string | null = currentNode;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        throw new Error("ChatGPT active path contains a cycle");
      }
      visited.add(cursor);
      const node: RawMappingNode | undefined = mapping[cursor];
      if (node === undefined) {
        throw new Error("ChatGPT active path references a missing node");
      }
      result.push(node);
      cursor = typeof node.parent === "string" ? node.parent : null;
    }
    return result.reverse();
  }

  return Object.values(mapping).sort((left, right) => {
    const leftMessage = left.message as RawMessage | undefined;
    const rightMessage = right.message as RawMessage | undefined;
    const leftTime = typeof leftMessage?.create_time === "number" ? leftMessage.create_time : 0;
    const rightTime =
      typeof rightMessage?.create_time === "number" ? rightMessage.create_time : 0;
    return leftTime - rightTime;
  });
}

function normalizeConversation(
  input: unknown,
  projectId: string
): { rawIdentity: string; snapshot: ConversationSnapshot } {
  const conversation = record(input, "ChatGPT conversation");
  const rawIdentity = nonEmptyString(
    conversation.id ?? conversation.conversation_id,
    "ChatGPT conversation identity"
  );
  const mappingRecord = record(conversation.mapping, "ChatGPT conversation mapping");
  const mapping: Record<string, RawMappingNode> = {};
  for (const [key, value] of Object.entries(mappingRecord)) {
    mapping[key] = record(value, `ChatGPT mapping node ${key}`) as RawMappingNode;
  }

  const turns = activeNodes(mapping, conversation.current_node)
    .flatMap((node) => {
      if (node.message === undefined || node.message === null) {
        return [];
      }
      const message = record(node.message, "ChatGPT message") as RawMessage;
      const content = messageContent(message.content);
      if (content === null) {
        return [];
      }
      const messageIdentity = nonEmptyString(
        message.id ?? node.id,
        "ChatGPT message identity"
      );
      return [
        {
          schemaVersion: SCHEMA_VERSION,
          turnId: derivedStableId("turn", `${rawIdentity}:${messageIdentity}`),
          actor: actorFromMessage(message.author),
          occurredAt: utcTimestamp(message.create_time, "ChatGPT message"),
          content
        }
      ];
    });

  if (!turns.some((turn) => turn.actor === "user" || turn.actor === "assistant")) {
    throw new Error("ChatGPT conversation has no importable user or assistant turns");
  }

  return {
    rawIdentity,
    snapshot: ConversationSnapshotSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      sourceSystem: "chatgpt",
      projectId,
      conversationId: derivedStableId("conversation", rawIdentity),
      title: nonEmptyString(conversation.title, "ChatGPT conversation title"),
      createdAt: utcTimestamp(conversation.create_time, "ChatGPT conversation creation"),
      updatedAt: utcTimestamp(
        conversation.update_time ?? conversation.create_time,
        "ChatGPT conversation update"
      ),
      turns
    })
  };
}

export function normalizeChatGptExport(
  input: unknown,
  options: ChatGptExportOptions = {}
): ConversationSnapshot[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("ChatGPT export must be a non-empty conversation array");
  }
  const projectId = StableIdSchema.parse(options.projectId ?? "chatgpt-export");
  const seen = new Set<string>();
  const normalized = input.map((conversation) => {
    const result = normalizeConversation(conversation, projectId);
    if (seen.has(result.rawIdentity)) {
      throw new Error("duplicate ChatGPT conversation identity");
    }
    seen.add(result.rawIdentity);
    return result.snapshot;
  });

  // Force a complete, canonical validation pass before the caller may store anything.
  return normalized.map((snapshot) =>
    ConversationSnapshotSchema.parse(JSON.parse(canonicalJson(snapshot)) as unknown)
  );
}

export async function importChatGptExport(
  input: unknown,
  store: LocalEvidenceStore,
  options: ChatGptExportOptions = {}
): Promise<ChatGptExportImportResult> {
  const snapshots = normalizeChatGptExport(input, options);
  const ingestions: ConversationIngestionResult[] = [];
  for (const snapshot of snapshots) {
    ingestions.push(await ingestConversationSnapshot(snapshot, store));
  }
  return { snapshots, ingestions };
}
