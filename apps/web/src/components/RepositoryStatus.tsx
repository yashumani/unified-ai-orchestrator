import type { RepositoryStatus as RepositoryStatusType } from "../api";
import type { ResourceState } from "../hooks/useOperatorData";
import { PanelState } from "./PanelState";

interface RepositoryStatusProps {
  resource: ResourceState<RepositoryStatusType>;
  onRetry: () => void;
}

export function RepositoryStatus({ resource, onRetry }: RepositoryStatusProps) {
  const repository = resource.data;

  return (
    <section className="panel repository-panel" aria-labelledby="repository-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2 id="repository-title">Repository status</h2>
        </div>
        {repository === null ? null : (
          <span className={`state-chip ${repository.clean ? "state-chip--go" : "state-chip--hold"}`}>
            {repository.clean ? "clean" : "changes"}
          </span>
        )}
      </div>

      {resource.loading && repository === null ? (
        <PanelState
          kind="loading"
          title="Reading repository state"
          detail="Checking the current branch and working tree."
        />
      ) : null}
      {resource.error !== null && repository === null ? (
        <PanelState
          kind="error"
          title="Repository status unavailable"
          detail={resource.error}
          onRetry={onRetry}
        />
      ) : null}
      {repository === null ? null : (
        <div className="repository-summary">
          <span>Branch</span>
          <code>{repository.branch}</code>
          <p className="quiet-message">
            {repository.stagedCount} staged · {repository.unstagedCount} unstaged ·{" "}
            {repository.conflictCount} conflicted
          </p>
          {repository.clean ? (
            <p className="quiet-message">No working-tree changes reported.</p>
          ) : repository.entries.length === 0 ? (
            <p className="quiet-message">
              Changes exist, but their names are intentionally omitted by the repository boundary.
            </p>
          ) : (
            <details>
              <summary>
                Inspect {repository.entries.length} reported change{repository.entries.length === 1 ? "" : "s"}
              </summary>
              <ul className="change-list">
                {repository.entries.slice(0, 12).map((entry, index) => (
                  <li key={`${entry}-${String(index)}`}>
                    <code>{entry}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {repository.untrackedEntriesOmitted ? (
            <p className="action-note action-note--warning">
              Untracked entries exist. Their names are intentionally hidden from the model and browser.
            </p>
          ) : null}
          {repository.protectedEntriesOmitted ? (
            <p className="action-note action-note--warning">
              Protected repository entries exist and are intentionally omitted.
            </p>
          ) : null}
          {repository.truncated ? (
            <p className="action-note action-note--warning">
              The server bounded this status result. Use the chat to request a focused inspection.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
