import {
  MALFORMED_TOOL_CALL_NAME,
  PolicyDecisionSchema,
  RepositoryToolNameSchema,
  ToolCallSchema,
  ToolResultSchema,
  type PolicyDecision,
  type RepositoryToolName,
  type ToolCall,
  type ToolDefinition,
  type ToolResult
} from "@unified-ai/contracts";
import { z } from "zod";
import { runNpmScript } from "./npm-tool.js";
import {
  getGitDiff,
  getGitStatus,
  listRepositoryFiles,
  readRepositoryFile,
  searchRepository
} from "./read-tools.js";
import {
  createRepositoryDirectory,
  replaceRepositoryText,
  writeRepositoryFile
} from "./write-tools.js";

const readFileInput = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(1_000).optional()
}).strict();
const listFilesInput = z.object({
  prefix: z.string().min(1).optional(),
  limit: z.number().int().positive().max(2_000).optional()
}).strict();
const searchInput = z.object({
  query: z.string().min(1).max(1_000),
  limit: z.number().int().positive().max(500).optional(),
  caseSensitive: z.boolean().optional()
}).strict();
const optionalPathInput = z.object({ path: z.string().min(1).optional() }).strict();
const writeFileInput = z.object({
  path: z.string().min(1),
  content: z.string().max(1_000_000),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();
const replaceInput = z.object({
  path: z.string().min(1),
  search: z.string().min(1),
  replacement: z.string(),
  expectedOccurrences: z.number().int().positive(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
const directoryInput = z.object({ path: z.string().min(1) }).strict();
const npmInput = z.object({ script: z.string().min(1) }).strict();

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("Repository tool execution was cancelled.", "AbortError");
  }
}

const definitions: ToolDefinition[] = [
  {
    name: "repository.list_files",
    description: "List tracked public repository files with an optional path prefix.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Optional repository-relative directory prefix." },
        limit: { type: "integer", minimum: 1, maximum: 2_000, default: 500 }
      },
      additionalProperties: false
    }
  },
  {
    name: "repository.read_file",
    description: "Read a bounded line chunk from one public UTF-8 repository file.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative public file path." },
        startLine: { type: "integer", minimum: 1, default: 1 },
        lineCount: { type: "integer", minimum: 1, maximum: 1_000, default: 200 }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "repository.search",
    description: "Search bounded public repository text for a literal query.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 1_000 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        caseSensitive: { type: "boolean", default: false }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "repository.git_status",
    description: "Read repository Git branch and working-tree status without mutation.",
    mode: "read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "repository.git_diff",
    description: "Read the unstaged Git diff, optionally limited to one public path.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Optional public repository-relative path." } },
      additionalProperties: false
    }
  },
  {
    name: "repository.write_file",
    description: "Create a public text file, or replace one only with its current SHA-256 precondition.",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", maxLength: 1_000_000 },
        expectedSha256: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "Required when the target already exists."
        }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    name: "repository.replace_text",
    description: "Replace exact text with current-file SHA-256 and exact occurrence-count preconditions.",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string", minLength: 1 },
        replacement: { type: "string" },
        expectedOccurrences: { type: "integer", minimum: 1 },
        expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
      },
      required: ["path", "search", "replacement", "expectedOccurrences", "expectedSha256"],
      additionalProperties: false
    }
  },
  {
    name: "repository.create_directory",
    description: "Create a public repository directory after policy and path validation.",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "repository.run_npm_script",
    description: "Run one fixed, metadata-only verification command without arbitrary arguments.",
    mode: "write",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          enum: ["check:public-boundary", "typecheck"]
        }
      },
      required: ["script"],
      additionalProperties: false
    }
  }
];

const mutatingTools = new Set<string>(
  definitions.filter((definition) => definition.mode === "write").map((definition) => definition.name)
);

export interface RepositoryToolRegistryOptions {
  repositoryRoot: string;
  authorizeMutation: (call: ToolCall) => Promise<PolicyDecision>;
}

export class RepositoryToolRegistry {
  readonly #repositoryRoot: string;
  readonly #authorizeMutation: (call: ToolCall) => Promise<PolicyDecision>;

  constructor(options: RepositoryToolRegistryOptions) {
    this.#repositoryRoot = options.repositoryRoot;
    this.#authorizeMutation = options.authorizeMutation;
  }

  listDefinitions(): ToolDefinition[] {
    return definitions.map((definition) => ({
      ...definition,
      inputSchema: structuredClone(definition.inputSchema)
    }));
  }

  async execute(
    rawCall: ToolCall,
    options: { signal?: AbortSignal } = {}
  ): Promise<ToolResult> {
    const call = ToolCallSchema.parse(rawCall);
    throwIfAborted(options.signal);
    let mutationPolicy: PolicyDecision | undefined;
    const knownTool = RepositoryToolNameSchema.safeParse(call.toolName);
    if (!knownTool.success) {
      const malformed = call.toolName === MALFORMED_TOOL_CALL_NAME;
      return ToolResultSchema.parse({
        callId: call.callId,
        toolName: call.toolName,
        ok: false,
        summary: malformed
          ? "Policy rejected a malformed model tool call."
          : "Policy rejected an unknown tool name.",
        data: {
          policy: {
            allowed: false,
            code: malformed ? "invalid_input" : "tool_not_allowed",
            reason: malformed
              ? "The local model returned a structurally invalid tool call."
              : "The requested tool is not in the fixed repository tool catalog.",
            checkedAt: new Date().toISOString()
          }
        },
        truncated: false
      });
    }
    if (mutatingTools.has(call.toolName)) {
      const decision = PolicyDecisionSchema.parse(await this.#authorizeMutation(call));
      if (!decision.allowed) {
        return ToolResultSchema.parse({
          callId: call.callId,
          toolName: call.toolName,
          ok: false,
          summary: `Policy blocked the tool: ${decision.code}.`,
          data: { policy: decision },
          truncated: false
        });
      }
      mutationPolicy = decision;
    }

    try {
      const data = await this.#dispatch(call, options.signal);
      throwIfAborted(options.signal);
      const resultData =
        mutationPolicy === undefined
          ? data
          : {
              ...(typeof data === "object" && data !== null && !Array.isArray(data)
                ? data
                : { value: data }),
              policy: mutationPolicy
            };
      return ToolResultSchema.parse({
        callId: call.callId,
        toolName: call.toolName,
        ok: true,
        summary: `${call.toolName} completed.`,
        data: resultData,
        truncated: typeof data === "object" && data !== null && "truncated" in data
          ? (data as { truncated?: unknown }).truncated === true
          : false
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      return ToolResultSchema.parse({
        callId: call.callId,
        toolName: call.toolName,
        ok: false,
        summary: "Repository tool arguments or execution failed safely.",
        data: {
          policy: {
            allowed: false,
            code: "invalid_input",
            reason: "The requested tool arguments or bounded execution were invalid.",
            checkedAt: new Date().toISOString()
          }
        },
        truncated: false
      });
    }
  }

  async #dispatch(call: ToolCall, signal?: AbortSignal): Promise<unknown> {
    switch (call.toolName) {
      case "repository.list_files": {
        const input = listFilesInput.parse(call.arguments);
        return listRepositoryFiles(this.#repositoryRoot, {
          ...input,
          ...(signal === undefined ? {} : { signal })
        });
      }
      case "repository.read_file": {
        const input = readFileInput.parse(call.arguments);
        return readRepositoryFile(this.#repositoryRoot, input.path, {
          ...input,
          ...(signal === undefined ? {} : { signal })
        });
      }
      case "repository.search": {
        const input = searchInput.parse(call.arguments);
        return searchRepository(this.#repositoryRoot, input.query, {
          ...input,
          ...(signal === undefined ? {} : { signal })
        });
      }
      case "repository.git_status":
        optionalPathInput.parse(call.arguments);
        return getGitStatus(this.#repositoryRoot, signal);
      case "repository.git_diff": {
        const input = optionalPathInput.parse(call.arguments);
        return getGitDiff(this.#repositoryRoot, input.path, signal);
      }
      case "repository.write_file":
        return writeRepositoryFile(this.#repositoryRoot, writeFileInput.parse(call.arguments));
      case "repository.replace_text":
        return replaceRepositoryText(this.#repositoryRoot, replaceInput.parse(call.arguments));
      case "repository.create_directory": {
        const input = directoryInput.parse(call.arguments);
        return createRepositoryDirectory(this.#repositoryRoot, input.path);
      }
      case "repository.run_npm_script": {
        const input = npmInput.parse(call.arguments);
        return runNpmScript(this.#repositoryRoot, input.script, {
          ...(signal === undefined ? {} : { signal })
        });
      }
      default:
        throw new Error("unknown repository tool");
    }
  }
}
