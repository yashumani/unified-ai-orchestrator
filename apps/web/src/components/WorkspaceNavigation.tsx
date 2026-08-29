import type { MouseEvent } from "react";
import {
  workspaceHref,
  type WorkspaceId
} from "../hooks/useWorkspaceNavigation";

const WORKSPACES: ReadonlyArray<{
  id: WorkspaceId;
  label: string;
  description: string;
}> = [
  {
    id: "operator",
    label: "Operator",
    description: "Runtime, trust, and governed chat"
  },
  {
    id: "portfolio",
    label: "Portfolio",
    description: "Repository evidence and decisions"
  },
  {
    id: "dashboard-builder",
    label: "Dashboard builder",
    description: "Manifest authoring and preview"
  }
];

interface WorkspaceNavigationProps {
  activeWorkspace: WorkspaceId;
  onNavigate: (workspace: WorkspaceId) => void;
}

function shouldUseBrowserNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

export function WorkspaceNavigation({
  activeWorkspace,
  onNavigate
}: WorkspaceNavigationProps) {
  return (
    <div className="workspace-navigation">
      <div className="workspace-navigation__identity">
        <span>Local control surfaces</span>
        <strong>Workspaces</strong>
      </div>
      <nav className="workspace-navigation__links" aria-label="Workspaces">
        {WORKSPACES.map((workspace) => (
          <a
            href={workspaceHref(workspace.id)}
            key={workspace.id}
            {...(activeWorkspace === workspace.id
              ? { "aria-current": "page" as const }
              : {})}
            onClick={(event) => {
              if (shouldUseBrowserNavigation(event)) {
                return;
              }
              event.preventDefault();
              onNavigate(workspace.id);
            }}
          >
            <strong>{workspace.label}</strong>
            <span>{workspace.description}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
