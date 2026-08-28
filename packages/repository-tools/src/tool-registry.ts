import {
  PolicyDecisionSchema,
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

const definitions: ToolDefinition[] = [
  { name: "repository.list_files", description: "List tracked public repository files.", mode: "read", inputSchema: { type: "object" } },
  { name: "repository.read_file", description: "Read a bounded chunk of one public text file.", mode: "read", inputSchema: { type: "object", required: ["path"] } },
  { name: "repository.search", description: "Search bounded public repository text.", mode: "read", inputSchema: { type: "object", required: ["query"] } },
  { name: "repository.git_status", description: "Read repository Git status.", mode: "read", inputSchema: { type: "object" } },
  { name: "repository.git_diff", description: "Read the unstaged Git diff.", mode: "read", inputSchema: { type: "object" } },
  { name: "repository.write_file", description: "Create or precondition-replace a public text file.", mode: "write", inputSchema: { type: "object", required: ["path", "content"] } },
  { name: "repository.replace_text", description: "Replace exact text with hash and occurrence preconditions.", mode: "write", inputSchema: { type: "object", required: ["path", "search", "replacement", "expectedOccurrences", "expectedSha256"] } },
  { name: "repository.create_directory", description: "Create a public repository directory.", mode: "write", inputSchema: { type: "object", required: ["path"] } },
  { name: "repository.run_npm_script", description: "Run one fixed allowlisted root npm script.", mode: "write", inputSchema: { type: "object", required: ["script"] } }
];

const mutatingTools = new Set<RepositoryToolName>(
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
    return definitions.map((definition) => ({ ...definition, inputSchema: { ...definition.inputSchema } }));
  }

  async execute(rawCall: ToolCall): Promise<ToolResult> {
    const call = ToolCallSchema.parse(rawCall);
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
    }

    try {
      const data = await this.#dispatch(call);
      return ToolResultSchema.parse({
        callId: call.callId,
        toolName: call.toolName,
        ok: true,
        summary: `${call.toolName} completed.`,
        data,
        truncated: typeof data === "object" && data !== null && "truncated" in data
          ? (data as { truncated?: unknown }).truncated === true
          : false
      });
    } catch (error) {
      return ToolResultSchema.parse({
        callId: call.callId,
        toolName: call.toolName,
        ok: false,
        summary: error instanceof Error ? error.message : "repository tool failed",
        truncated: false
      });
    }
  }

  async #dispatch(call: ToolCall): Promise<unknown> {
    switch (call.toolName) {
      case "repository.list_files": {
        const input = listFilesInput.parse(call.arguments);
        return listRepositoryFiles(this.#repositoryRoot, input);
      }
      case "repository.read_file": {
        const input = readFileInput.parse(call.arguments);
        return readRepositoryFile(this.#repositoryRoot, input.path, input);
      }
      case "repository.search": {
        const input = searchInput.parse(call.arguments);
        return searchRepository(this.#repositoryRoot, input.query, input);
      }
      case "repository.git_status":
        optionalPathInput.parse(call.arguments);
        return getGitStatus(this.#repositoryRoot);
      case "repository.git_diff": {
        const input = optionalPathInput.parse(call.arguments);
        return getGitDiff(this.#repositoryRoot, input.path);
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
        return runNpmScript(this.#repositoryRoot, input.script);
      }
    }
  }
}
