import { AgentRunner, type RepositoryToolPort } from "@unified-ai/agent-runtime";
import {
  PINNED_OLLAMA_MODEL,
  RepositoryToolNameSchema,
  RuntimeServiceStateSchema,
  type RuntimeServiceState,
  type ToolCall
} from "@unified-ai/contracts";
import { LocalEvidenceStore } from "@unified-ai/evidence-index";
import {
  DashboardAdapterRegistry,
  DashboardService,
  FixtureDashboardAdapter,
  QlikDashboardAdapter,
  loadDashboardSample
} from "@unified-ai/dashboard-builder";
import { OllamaClient } from "@unified-ai/ollama-client";
import { PolicyEngine } from "@unified-ai/policy-engine";
import {
  GitHubPortfolioIngestor,
  GitHubRestClient
} from "@unified-ai/portfolio-ingestion";
import {
  PortfolioService,
  TwoPassOllamaPortfolioClassifier
} from "@unified-ai/portfolio-reconciliation";
import { RepositoryToolRegistry } from "@unified-ai/repository-tools";
import { RuntimeManager } from "@unified-ai/runtime-manager";
import { importChatGptExport } from "@unified-ai/session-ingestion";
import { WhiteShadowClient } from "@unified-ai/whiteshadow-client";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  validateCanonicalRuntimePaths,
  type OrchestratorConfig
} from "./config.js";
import { CompositeToolRegistry, PortfolioToolRegistry } from "./portfolio-tools.js";
import type { DashboardBuilderRouteContext } from "./dashboard-builder-routes.js";

const PORTFOLIO_GITHUB_OWNER = "yashumani";
const PORTFOLIO_ORCHESTRATOR_REPOSITORY =
  `${PORTFOLIO_GITHUB_OWNER}/unified-ai-orchestrator`;

export interface OrchestratorServices {
  config: OrchestratorConfig;
  ollama: OllamaClient;
  whiteshadow: WhiteShadowClient;
  policy: PolicyEngine;
  repositoryTools: RepositoryToolRegistry;
  tools: RepositoryToolPort;
  evidence: LocalEvidenceStore;
  dashboardBuilder: DashboardBuilderRouteContext;
  portfolio: PortfolioService;
  agent: AgentRunner;
  runtime: RuntimeManager;
}

function timestamp(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeProbeDetail(service: string, error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `${service} is unavailable: ${error.message.slice(0, 500)}`;
  }
  return `${service} is unavailable.`;
}

function mutationPath(call: ToolCall): string | undefined {
  if (
    call.toolName !== "repository.write_file" &&
    call.toolName !== "repository.replace_text" &&
    call.toolName !== "repository.create_directory"
  ) {
    return undefined;
  }
  const argumentsRecord =
    typeof call.arguments === "object" &&
    call.arguments !== null &&
    !Array.isArray(call.arguments)
      ? (call.arguments as Record<string, unknown>)
      : {};
  const path = argumentsRecord["path"];
  return typeof path === "string" ? path : undefined;
}

function childEnvironment(
  additions: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const allowed = [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE"
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return { ...environment, ...additions };
}

export async function createServices(
  config: OrchestratorConfig
): Promise<OrchestratorServices> {
  await validateCanonicalRuntimePaths(config);
  const ollama = new OllamaClient({
    baseUrl: config.ollamaBaseUrl,
    model: PINNED_OLLAMA_MODEL
  });
  const whiteshadow = new WhiteShadowClient({ baseUrl: config.whiteshadowBaseUrl });
  const policy = new PolicyEngine({
    repositoryRoot: config.repositoryRoot,
    grantRelativePath: config.trustGrantRelativePath
  });
  const repositoryTools = new RepositoryToolRegistry({
    repositoryRoot: config.repositoryRoot,
    authorizeMutation: async (call) => {
      const path = mutationPath(call);
      const authorization = await policy.evaluateMutation({
        toolName: RepositoryToolNameSchema.parse(call.toolName),
        ...(path === undefined ? {} : { repositoryRelativePath: path })
      });
      return authorization.decision;
    }
  });
  const evidence = new LocalEvidenceStore({
    root: config.evidenceRoot,
    repositoryRoot: config.repositoryRoot
  });
  await evidence.initialize();
  const dashboardSample = await loadDashboardSample(config.repositoryRoot);
  const dashboardService = new DashboardService({
    evidence,
    adapters: new DashboardAdapterRegistry([
      new FixtureDashboardAdapter(dashboardSample.fixture),
      new QlikDashboardAdapter({ enabled: false })
    ])
  });
  await dashboardService.initialize();
  const dashboardBuilder: DashboardBuilderRouteContext = {
    service: dashboardService,
    sample: {
      manifest: dashboardSample.manifest,
      manifestBytes: dashboardSample.manifestBytes
    }
  };
  const github = new GitHubRestClient({
    credentials: {
      getToken: async () => {
        const token = process.env["GITHUB_TOKEN"]?.trim() ??
          process.env["GH_TOKEN"]?.trim();
        return token === undefined || token.length === 0 ? undefined : token;
      }
    }
  });
  const portfolio = new PortfolioService({
    owner: PORTFOLIO_GITHUB_OWNER,
    orchestratorFullName: PORTFOLIO_ORCHESTRATOR_REPOSITORY,
    ingestor: new GitHubPortfolioIngestor({ client: github }),
    evidence,
    classifier: new TwoPassOllamaPortfolioClassifier(ollama),
    chatImporter: {
      import: async (input, projectId) =>
        await importChatGptExport(input, evidence, { projectId })
    }
  });
  await portfolio.initialize();
  const tools = new CompositeToolRegistry(
    repositoryTools,
    new PortfolioToolRegistry(portfolio)
  );
  const agent = new AgentRunner({
    ollama,
    tools,
    evidence,
    workspaceContext: async () => {
      const trust = await policy.getTrustState();
      return {
        repositoryRootSha256: sha256(trust.identity.repositoryRoot),
        originSha256: trust.identity.originSha256,
        branch: trust.identity.branch,
        ...(trust.grant === null
          ? {}
          : { trustGrantSha256: sha256(JSON.stringify(trust.grant)) })
      };
    }
  });

  const ollamaAdapter = {
    status: async (): Promise<RuntimeServiceState> => {
      try {
        const health = await ollama.probeHealth();
        return RuntimeServiceStateSchema.parse({
          service: "ollama",
          phase: "ready",
          endpoint: `${config.ollamaBaseUrl}/`,
          checkedAt: timestamp(),
          detail: `Ollama ${health.version} is reachable.`
        });
      } catch (error) {
        return RuntimeServiceStateSchema.parse({
          service: "ollama",
          phase: "offline",
          endpoint: `${config.ollamaBaseUrl}/`,
          checkedAt: timestamp(),
          detail: safeProbeDetail("Ollama", error)
        });
      }
    },
    hasModel: async (model: typeof PINNED_OLLAMA_MODEL): Promise<boolean> => {
      if (model !== PINNED_OLLAMA_MODEL) {
        return false;
      }
      return (await ollama.probeModelInventory()).pinnedModelAvailable;
    }
  };

  const runtime = new RuntimeManager({
    ollama: ollamaAdapter,
    whiteshadow,
    ollamaLaunch: {
      command: config.ollamaExecutable,
      args: ["serve"],
      cwd: dirname(config.ollamaExecutable),
      env: childEnvironment({ OLLAMA_HOST: config.ollamaBaseUrl })
    },
    whiteshadowLaunch: {
      command: config.whiteshadowPython,
      args: [
        "-m",
        "training.webapp.server",
        "--host",
        "127.0.0.1",
        "--port",
        "8787"
      ],
      cwd: config.whiteshadowWorkspace,
      env: childEnvironment({
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      })
    }
  });

  return {
    config,
    ollama,
    whiteshadow,
    policy,
    repositoryTools,
    tools,
    evidence,
    dashboardBuilder,
    portfolio,
    agent,
    runtime
  };
}
