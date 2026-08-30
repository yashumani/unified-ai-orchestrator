import type {
  AgentRunReceipt,
  RuntimeStatus,
  TrustState
} from "@unified-ai/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCapabilities,
  getRepositoryStatus,
  getRuns,
  getRuntimeStatus,
  getTrustState,
  grantTrust,
  revokeTrust,
  startRuntime,
  type RepositoryStatus,
  type WhiteShadowCapabilityFeed
} from "../api";

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export type OperatorAction = "start" | "grant" | "revoke";

export interface ActionNotice {
  action: OperatorAction;
  kind: "error" | "success";
  message: string;
}

interface OperatorState {
  runtime: ResourceState<RuntimeStatus>;
  trust: ResourceState<TrustState>;
  repository: ResourceState<RepositoryStatus>;
  runs: ResourceState<AgentRunReceipt[]>;
  capabilities: ResourceState<WhiteShadowCapabilityFeed>;
}

const initialResource = <T,>(): ResourceState<T> => ({
  data: null,
  loading: true,
  error: null
});

const initialState: OperatorState = {
  runtime: initialResource<RuntimeStatus>(),
  trust: initialResource<TrustState>(),
  repository: initialResource<RepositoryStatus>(),
  runs: initialResource<AgentRunReceipt[]>(),
  capabilities: initialResource<WhiteShadowCapabilityFeed>()
};

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  return "The local API did not return a usable response.";
}

function settle<T>(
  result: PromiseSettledResult<T>,
  previous: ResourceState<T>
): ResourceState<T> {
  if (result.status === "fulfilled") {
    return { data: result.value, loading: false, error: null };
  }
  return {
    data: previous.data,
    loading: false,
    error: errorMessage(result.reason)
  };
}

export function useOperatorData() {
  const [state, setState] = useState<OperatorState>(initialState);
  const [pendingAction, setPendingAction] = useState<OperatorAction | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const mountedRef = useRef(false);
  const refreshRevisionRef = useRef(0);

  const refresh = useCallback(
    async (options: { background?: boolean; signal?: AbortSignal } = {}) => {
      const revision = ++refreshRevisionRef.current;
      if (options.background !== true && mountedRef.current) {
        setState((previous) => ({
          runtime: { ...previous.runtime, loading: true, error: null },
          trust: { ...previous.trust, loading: true, error: null },
          repository: { ...previous.repository, loading: true, error: null },
          runs: { ...previous.runs, loading: true, error: null },
          capabilities: {
            ...previous.capabilities,
            loading: true,
            error: null
          }
        }));
      }

      const [runtime, trust, repository, runs, capabilities] =
        await Promise.allSettled([
          getRuntimeStatus(options.signal),
          getTrustState(options.signal),
          getRepositoryStatus(options.signal),
          getRuns(options.signal),
          getCapabilities(options.signal)
        ]);

      if (
        !mountedRef.current ||
        options.signal?.aborted === true ||
        revision !== refreshRevisionRef.current
      ) {
        return;
      }

      setState((previous) => ({
        runtime: settle(runtime, previous.runtime),
        trust: settle(trust, previous.trust),
        repository: settle(repository, previous.repository),
        runs: settle(runs, previous.runs),
        capabilities: settle(capabilities, previous.capabilities)
      }));
      setLastUpdated(new Date());
    },
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void refresh({ signal: controller.signal });
    const interval = window.setInterval(() => {
      void refresh({ background: true });
    }, 15_000);

    return () => {
      mountedRef.current = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (
      action: OperatorAction,
      request: () => Promise<RuntimeStatus | TrustState>
    ) => {
      setPendingAction(action);
      setActionNotice(null);
      try {
        const result = await request();
        if (!mountedRef.current) {
          return;
        }
        if (action === "start") {
          setState((previous) => ({
            ...previous,
            runtime: {
              data: result as RuntimeStatus,
              loading: false,
              error: null
            }
          }));
          setActionNotice({
            action,
            kind: "success",
            message: "Local AI startup check completed."
          });
        } else {
          setState((previous) => ({
            ...previous,
            trust: {
              data: result as TrustState,
              loading: false,
              error: null
            }
          }));
          setActionNotice({
            action,
            kind: "success",
            message:
              action === "grant"
                ? "Permanent workspace trust granted."
                : "Workspace trust revoked."
          });
        }
        await refresh({ background: true });
      } catch (error) {
        if (mountedRef.current) {
          setActionNotice({
            action,
            kind: "error",
            message: errorMessage(error)
          });
        }
      } finally {
        if (mountedRef.current) {
          setPendingAction(null);
        }
      }
    },
    [refresh]
  );

  return {
    ...state,
    pendingAction,
    actionNotice,
    lastUpdated,
    refresh: () => refresh(),
    start: () => runAction("start", startRuntime),
    grant: () => runAction("grant", grantTrust),
    revoke: () => runAction("revoke", revokeTrust)
  };
}
