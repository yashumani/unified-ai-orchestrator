import { useCallback, useEffect, useRef, useState } from "react";
import {
  getPortfolioClusters,
  getPortfolioRecommendations,
  getPortfolioRepositories,
  getPortfolioRuns,
  importPortfolioChats,
  overridePortfolioRecommendation,
  startPortfolioRun
} from "../portfolio-api";
import type {
  ChatImportBody,
  ChatImportResponse,
  PortfolioCluster,
  PortfolioRecommendation,
  PortfolioRepository,
  PortfolioRun,
  RecommendationOverrideBody,
  RecommendationOverrideResponse,
  StartPortfolioRunResponse
} from "../portfolio-types";

export interface PortfolioResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface PortfolioState {
  runs: PortfolioResource<PortfolioRun[]>;
  repositories: PortfolioResource<PortfolioRepository[]>;
  clusters: PortfolioResource<PortfolioCluster[]>;
  recommendations: PortfolioResource<PortfolioRecommendation[]>;
}

const initialResource = <T,>(): PortfolioResource<T> => ({
  data: null,
  loading: true,
  error: null
});

const initialState: PortfolioState = {
  runs: initialResource<PortfolioRun[]>(),
  repositories: initialResource<PortfolioRepository[]>(),
  clusters: initialResource<PortfolioCluster[]>(),
  recommendations: initialResource<PortfolioRecommendation[]>()
};

function messageFrom(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "The local portfolio API did not return a usable response.";
}

function settle<T>(
  result: PromiseSettledResult<T>,
  previous: PortfolioResource<T>
): PortfolioResource<T> {
  if (result.status === "fulfilled") {
    return { data: result.value, loading: false, error: null };
  }
  return {
    data: previous.data,
    loading: false,
    error: messageFrom(result.reason)
  };
}

export function usePortfolioData() {
  const [state, setState] = useState<PortfolioState>(initialState);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const mountedRef = useRef(false);
  const revisionRef = useRef(0);

  const refresh = useCallback(
    async (options: { initial?: boolean; signal?: AbortSignal } = {}) => {
      const revision = ++revisionRef.current;
      if (options.initial !== true && mountedRef.current) {
        setRefreshing(true);
        setState((previous) => ({
          runs: { ...previous.runs, loading: true, error: null },
          repositories: {
            ...previous.repositories,
            loading: true,
            error: null
          },
          clusters: { ...previous.clusters, loading: true, error: null },
          recommendations: {
            ...previous.recommendations,
            loading: true,
            error: null
          }
        }));
      }

      const [runs, repositories, clusters, recommendations] =
        await Promise.allSettled([
          getPortfolioRuns(options.signal),
          getPortfolioRepositories(options.signal),
          getPortfolioClusters(options.signal),
          getPortfolioRecommendations(options.signal)
        ]);

      if (
        !mountedRef.current ||
        options.signal?.aborted === true ||
        revision !== revisionRef.current
      ) {
        return;
      }

      setState((previous) => ({
        runs: settle(runs, previous.runs),
        repositories: settle(repositories, previous.repositories),
        clusters: settle(clusters, previous.clusters),
        recommendations: settle(recommendations, previous.recommendations)
      }));
      setRefreshing(false);
      setLastUpdated(new Date());
    },
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void refresh({ initial: true, signal: controller.signal });
    const interval = window.setInterval(() => {
      void refresh();
    }, 15_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      controller.abort();
    };
  }, [refresh]);

  const start = useCallback(async (): Promise<StartPortfolioRunResponse> => {
    setStarting(true);
    try {
      const response = await startPortfolioRun();
      await refresh();
      return response;
    } finally {
      if (mountedRef.current) {
        setStarting(false);
      }
    }
  }, [refresh]);

  const importChats = useCallback(
    async (body: ChatImportBody): Promise<ChatImportResponse> => {
      const response = await importPortfolioChats(body);
      await refresh();
      return response;
    },
    [refresh]
  );

  const overrideRecommendation = useCallback(
    async (
      recommendationId: string,
      body: RecommendationOverrideBody
    ): Promise<RecommendationOverrideResponse> => {
      const response = await overridePortfolioRecommendation(
        recommendationId,
        body
      );
      await refresh();
      return response;
    },
    [refresh]
  );

  return {
    ...state,
    refreshing,
    starting,
    lastUpdated,
    refresh: () => refresh(),
    start,
    importChats,
    overrideRecommendation
  };
}
