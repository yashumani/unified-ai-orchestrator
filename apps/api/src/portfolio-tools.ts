import type { RepositoryToolPort } from "@unified-ai/agent-runtime";
import {
  ToolCallSchema,
  ToolResultSchema,
  type ToolCall,
  type ToolDefinition,
  type ToolResult
} from "@unified-ai/contracts";
import type { PortfolioService } from "@unified-ai/portfolio-reconciliation";
import { z } from "zod";

const emptyInput = z.object({}).strict();
const repositoryInput = z.object({ repositoryId: z.string().min(1) }).strict();
const clusterInput = z.object({ clusterId: z.string().min(1) }).strict();
const citationInput = z.object({ citationId: z.string().min(1) }).strict();
const recommendationListInput = z
  .object({
    action: z.string().min(1).optional(),
    lifecycle: z.string().min(1).optional()
  })
  .strict();

const portfolioDefinitions: ToolDefinition[] = [
  {
    name: "portfolio.list_repositories",
    description:
      "List sanitized repository profiles from the latest completed local portfolio audit. This is read-only and cannot refresh GitHub.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "portfolio.get_repository",
    description:
      "Read one sanitized repository profile, evidence coverage, contradictions, and citations from the latest local audit.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { repositoryId: { type: "string" } },
      required: ["repositoryId"],
      additionalProperties: false
    }
  },
  {
    name: "portfolio.list_clusters",
    description:
      "List deterministic portfolio overlap clusters from the latest completed audit.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "portfolio.explain_overlap",
    description:
      "Read one deterministic overlap cluster with its member repositories and cited shared capabilities.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { clusterId: { type: "string" } },
      required: ["clusterId"],
      additionalProperties: false
    }
  },
  {
    name: "portfolio.list_recommendations",
    description:
      "List local cited rationalization recommendations, optionally filtered by action or lifecycle. This cannot change a decision.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        lifecycle: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "portfolio.resolve_citation",
    description:
      "Resolve one sanitized portfolio citation by its stable identity. Raw private evidence is never returned.",
    mode: "read",
    inputSchema: {
      type: "object",
      properties: { citationId: { type: "string" } },
      required: ["citationId"],
      additionalProperties: false
    }
  }
];

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("Portfolio tool execution was cancelled.", "AbortError");
  }
}

export class PortfolioToolRegistry implements RepositoryToolPort {
  readonly #portfolio: PortfolioService;

  constructor(portfolio: PortfolioService) {
    this.#portfolio = portfolio;
  }

  listDefinitions(): ToolDefinition[] {
    return portfolioDefinitions.map((definition) => ({
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
    try {
      const data = this.#dispatch(call);
      throwIfAborted(options.signal);
      return ToolResultSchema.parse({
        callId: call.callId,
        toolName: call.toolName,
        ok: true,
        summary: `${call.toolName} completed from sanitized local portfolio evidence.`,
        data,
        truncated: false
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw error;
      }
      return ToolResultSchema.parse({
        callId: call.callId,
        toolName: call.toolName,
        ok: false,
        summary: "Portfolio read arguments or evidence resolution failed safely.",
        data: {
          policy: {
            allowed: false,
            code: "invalid_input",
            reason:
              "The request was outside the fixed read-only portfolio tool catalog or referenced unavailable evidence.",
            checkedAt: new Date().toISOString()
          }
        },
        truncated: false
      });
    }
  }

  #dispatch(call: ToolCall): unknown {
    switch (call.toolName) {
      case "portfolio.list_repositories":
        emptyInput.parse(call.arguments);
        return { repositories: this.#portfolio.listRepositories() };
      case "portfolio.get_repository": {
        const input = repositoryInput.parse(call.arguments);
        return this.#portfolio.getRepository(input.repositoryId);
      }
      case "portfolio.list_clusters":
        emptyInput.parse(call.arguments);
        return { clusters: this.#portfolio.listClusters() };
      case "portfolio.explain_overlap": {
        const input = clusterInput.parse(call.arguments);
        return this.#portfolio.getCluster(input.clusterId);
      }
      case "portfolio.list_recommendations": {
        const input = recommendationListInput.parse(call.arguments);
        const recommendations = this.#portfolio
          .listRecommendations()
          .filter(
            (recommendation) =>
              (input.action === undefined ||
                recommendation.action === input.action) &&
              (input.lifecycle === undefined ||
                recommendation.lifecycle === input.lifecycle)
          );
        return { recommendations };
      }
      case "portfolio.resolve_citation": {
        const input = citationInput.parse(call.arguments);
        const citation = this.#portfolio
          .listRepositories()
          .flatMap((repository) => repository.citations)
          .find((candidate) => candidate.citationId === input.citationId);
        if (citation === undefined) {
          throw new Error("Portfolio citation was not found.");
        }
        return citation;
      }
      default:
        throw new Error("Unknown portfolio read tool.");
    }
  }
}

export class CompositeToolRegistry implements RepositoryToolPort {
  readonly #repository: RepositoryToolPort;
  readonly #portfolio: RepositoryToolPort;

  constructor(repository: RepositoryToolPort, portfolio: RepositoryToolPort) {
    this.#repository = repository;
    this.#portfolio = portfolio;
  }

  listDefinitions(): ToolDefinition[] {
    return [
      ...this.#repository.listDefinitions(),
      ...this.#portfolio.listDefinitions()
    ];
  }

  async execute(
    call: ToolCall,
    options: { signal?: AbortSignal } = {}
  ): Promise<ToolResult> {
    return call.toolName.startsWith("portfolio.")
      ? await this.#portfolio.execute(call, options)
      : await this.#repository.execute(call, options);
  }
}
