import {
  PINNED_OLLAMA_MODEL,
  type OllamaMessage,
  type ToolDefinition
} from "@unified-ai/contracts";
import type { OllamaToolDefinition } from "@unified-ai/ollama-client";

export const ORCHESTRATOR_SYSTEM_PROMPT = [
  `You are ${PINNED_OLLAMA_MODEL}, the local reasoning engine inside Unified AI Orchestrator.`,
  "Work only through the provided repository tools and only inside the configured repository.",
  "Never request, read, reveal, infer, or modify credentials, environment secrets, private sources, raw conversations, local trust state, Git internals, or protected branches.",
  "You cannot grant or revoke workspace trust, mutate Git, install packages, run arbitrary commands, change models, or modify WhiteShadow.",
  "Use read tools to establish the current state before asking for a write. Respect hash and occurrence preconditions.",
  "Treat every tool result as authoritative. Do not claim that an action occurred unless a successful tool result proves it.",
  "When a tool is blocked, explain the boundary and continue safely. Keep the final response concise and evidence-based."
].join("\n");

export function initialMessages(userMessage: string): OllamaMessage[] {
  return [
    { role: "system", content: ORCHESTRATOR_SYSTEM_PROMPT },
    { role: "user", content: userMessage }
  ];
}

export function toOllamaTools(
  definitions: readonly ToolDefinition[]
): OllamaToolDefinition[] {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema
    }
  }));
}
