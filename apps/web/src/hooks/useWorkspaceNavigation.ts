import { useCallback, useEffect, useRef, useState } from "react";

export const WORKSPACE_IDS = [
  "operator",
  "portfolio",
  "dashboard-builder"
] as const;

export type WorkspaceId = (typeof WORKSPACE_IDS)[number];
type WorkspaceNavigationGuard = (workspace: WorkspaceId) => boolean;

const allowWorkspaceNavigation: WorkspaceNavigationGuard = () => true;

export function workspaceFromSearch(search: string): WorkspaceId {
  const workspace = new URLSearchParams(search).get("workspace");
  return WORKSPACE_IDS.find((candidate) => candidate === workspace) ?? "operator";
}

export function workspaceHref(
  workspace: WorkspaceId,
  currentHref = window.location.href
): string {
  const url = new URL(currentHref);
  url.searchParams.set("workspace", workspace);
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

export function useWorkspaceNavigation(
  canNavigate: WorkspaceNavigationGuard = allowWorkspaceNavigation
) {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>(() =>
    workspaceFromSearch(window.location.search)
  );
  const activeWorkspaceRef = useRef(activeWorkspace);

  useEffect(() => {
    const followHistory = () => {
      const nextWorkspace = workspaceFromSearch(window.location.search);
      if (
        nextWorkspace !== activeWorkspaceRef.current &&
        !canNavigate(nextWorkspace)
      ) {
        window.history.pushState(
          {},
          "",
          workspaceHref(activeWorkspaceRef.current)
        );
        return;
      }
      activeWorkspaceRef.current = nextWorkspace;
      setActiveWorkspace(nextWorkspace);
    };
    window.addEventListener("popstate", followHistory);
    return () => {
      window.removeEventListener("popstate", followHistory);
    };
  }, [canNavigate]);

  const navigate = useCallback((workspace: WorkspaceId) => {
    if (workspace !== activeWorkspaceRef.current && !canNavigate(workspace)) {
      return;
    }
    const nextHref = workspaceHref(workspace);
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextHref !== currentHref) {
      window.history.pushState({}, "", nextHref);
    }
    activeWorkspaceRef.current = workspace;
    setActiveWorkspace(workspace);
  }, [canNavigate]);

  return { activeWorkspace, navigate };
}
