import { useCallback, useState } from "react";
import { OperatorWorkspace } from "./components/OperatorWorkspace";
import { PortfolioDashboard } from "./components/PortfolioDashboard";
import { WorkspaceNavigation } from "./components/WorkspaceNavigation";
import { DashboardBuilderWorkspace } from "./components/dashboard-builder/DashboardBuilderWorkspace";
import { useWorkspaceNavigation } from "./hooks/useWorkspaceNavigation";

export function App() {
  const [dashboardDirty, setDashboardDirty] = useState(false);
  const canNavigate = useCallback(
    (nextWorkspace: "operator" | "portfolio" | "dashboard-builder") => {
      if (!dashboardDirty || nextWorkspace === "dashboard-builder") {
        return true;
      }
      const discard = window.confirm(
        "Discard the unsaved dashboard changes and leave the builder?"
      );
      if (discard) {
        setDashboardDirty(false);
      }
      return discard;
    },
    [dashboardDirty]
  );
  const workspace = useWorkspaceNavigation(canNavigate);

  return (
    <div className="operator-shell">
      <a className="skip-link" href="#workspace-main">
        Skip to active workspace
      </a>
      <WorkspaceNavigation
        activeWorkspace={workspace.activeWorkspace}
        onNavigate={workspace.navigate}
      />

      {workspace.activeWorkspace === "operator" ? (
        <OperatorWorkspace />
      ) : workspace.activeWorkspace === "portfolio" ? (
        <main id="workspace-main" data-workspace="portfolio">
          <PortfolioDashboard />
        </main>
      ) : (
        <main id="workspace-main" data-workspace="dashboard-builder">
          <DashboardBuilderWorkspace onDirtyChange={setDashboardDirty} />
        </main>
      )}
    </div>
  );
}
