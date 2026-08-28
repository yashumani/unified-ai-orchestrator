import { PINNED_OLLAMA_MODEL, StableIdSchema } from "@unified-ai/contracts";
import { getGitStatus } from "@unified-ai/repository-tools";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { ApiError } from "./errors.js";
import type { OrchestratorServices } from "./composition.js";

const listRunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});
const capabilityParameter = z.object({ id: StableIdSchema });
const runParameter = z.object({ runId: StableIdSchema });

function asyncRoute(
  handler: (request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1]) => Promise<void>
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

export function createApiRouter(services: OrchestratorServices): Router {
  const router = Router();

  router.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      app: "unified-ai-orchestrator",
      mode: "local",
      model: PINNED_OLLAMA_MODEL
    });
  });

  router.get(
    "/runtime/status",
    asyncRoute(async (_request, response) => {
      response.json(await services.runtime.status());
    })
  );
  router.post(
    "/runtime/start",
    asyncRoute(async (_request, response) => {
      response.json(await services.runtime.start());
    })
  );

  router.get(
    "/trust",
    asyncRoute(async (_request, response) => {
      response.json(await services.policy.getTrustState());
    })
  );
  router.post(
    "/trust/grant",
    asyncRoute(async (_request, response) => {
      try {
        response.json(await services.policy.grantWorkspaceTrust());
      } catch {
        throw new ApiError(
          409,
          "policy_blocked",
          "Permanent trust cannot be granted for the current Git workspace state."
        );
      }
    })
  );
  router.post(
    "/trust/revoke",
    asyncRoute(async (_request, response) => {
      response.json(await services.policy.revokeWorkspaceTrust());
    })
  );

  router.get(
    "/repository/status",
    asyncRoute(async (_request, response) => {
      const status = await getGitStatus(services.config.repositoryRoot);
      response.json({
        branch: status.branch,
        clean: status.clean,
        stagedCount: status.stagedCount,
        unstagedCount: status.unstagedCount,
        conflictCount: status.conflictCount,
        entries: status.entries,
        protectedEntriesOmitted: status.protectedEntriesOmitted,
        untrackedEntriesOmitted: status.untrackedEntriesOmitted,
        truncated: status.truncated
      });
    })
  );

  router.get(
    "/whiteshadow/capabilities",
    asyncRoute(async (_request, response) => {
      const status = await services.whiteshadow.status();
      const available = status.phase === "ready";
      response.json({
        available,
        status,
        capabilities: available ? services.whiteshadow.listCapabilities() : []
      });
    })
  );
  router.get(
    "/whiteshadow/capabilities/:id",
    asyncRoute(async (request, response) => {
      const { id } = capabilityParameter.parse(request.params);
      if (
        !services.whiteshadow
          .listCapabilities()
          .some((capability) => capability.capabilityId === id)
      ) {
        throw new ApiError(
          404,
          "invalid_request",
          "The requested WhiteShadow capability is not allowlisted."
        );
      }
      try {
        response.json(await services.whiteshadow.invoke(id));
      } catch {
        throw new ApiError(
          502,
          "upstream_error",
          "The allowlisted WhiteShadow capability is unavailable.",
          true
        );
      }
    })
  );

  router.get(
    "/runs",
    asyncRoute(async (request, response) => {
      const { limit } = listRunsQuery.parse(request.query);
      response.json({ runs: await services.evidence.listAgentRunReceipts(limit) });
    })
  );
  router.get(
    "/runs/:runId",
    asyncRoute(async (request, response) => {
      const { runId } = runParameter.parse(request.params);
      try {
        response.json(await services.evidence.readAgentRunReceipt(runId));
      } catch {
        throw new ApiError(404, "invalid_request", "The requested run receipt was not found.");
      }
    })
  );

  return router;
}
