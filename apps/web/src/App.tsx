import { OperatorWorkspace } from "./components/OperatorWorkspace";
import { PortfolioDashboard } from "./components/PortfolioDashboard";
import { WorkspaceNavigation } from "./components/WorkspaceNavigation";
import { useWorkspaceNavigation } from "./hooks/useWorkspaceNavigation";

function DashboardBuilderPlaceholder() {
  return (
    <section
      className="dashboard-builder-placeholder"
      aria-labelledby="dashboard-builder-title"
    >
      <p className="eyebrow">Phase 3 · governed dashboard manifests</p>
      <h1 id="dashboard-builder-title">Dashboard builder</h1>
      <p>
        The Dashboard builder workspace shell is ready. Manifest editing, preview,
        publishing, and revision history will be connected here.
      </p>
    </section>
  );
}

export function App() {
  const workspace = useWorkspaceNavigation();

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
          <DashboardBuilderPlaceholder />
        </main>
      )}
    </div>
  );
}
