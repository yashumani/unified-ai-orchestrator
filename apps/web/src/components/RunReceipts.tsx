import type { AgentRunReceipt } from "@unified-ai/contracts";
import type { ResourceState } from "../hooks/useOperatorData";
import { PanelState } from "./PanelState";

interface RunReceiptsProps {
  resource: ResourceState<AgentRunReceipt[]>;
  onRetry: () => void;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function shortHash(value: string | undefined): string {
  return value === undefined ? "not recorded" : `${value.slice(0, 12)}…`;
}

export function RunReceipts({ resource, onRetry }: RunReceiptsProps) {
  const runs = resource.data;

  return (
    <section className="receipts-panel" aria-labelledby="receipts-title">
      <div className="receipts-heading">
        <div>
          <p className="eyebrow">Immutable evidence</p>
          <h2 id="receipts-title">Recent run receipts</h2>
          <p>Safe summaries of the last 12 agent runs. Prompt and file contents stay out of this view.</p>
        </div>
        <button className="secondary-button" type="button" onClick={onRetry} disabled={resource.loading}>
          Refresh receipts
        </button>
      </div>

      {resource.loading && runs === null ? (
        <PanelState
          kind="loading"
          title="Reading receipts"
          detail="Checking the local immutable evidence index."
        />
      ) : null}
      {resource.error !== null && runs === null ? (
        <PanelState
          kind="error"
          title="Receipts unavailable"
          detail={resource.error}
          onRetry={onRetry}
        />
      ) : null}
      {runs?.length === 0 ? (
        <PanelState
          kind="empty"
          title="No agent receipts yet"
          detail="Send a chat request. Its final state and policy decisions will appear here."
        />
      ) : null}
      {runs === null || runs.length === 0 ? null : (
        <ol className="receipt-list">
          {runs.map((run) => (
            <li className="receipt" key={run.runId}>
              <div className="receipt__rail" aria-hidden="true" />
              <article>
                <header>
                  <div>
                    <span className="receipt__id">{run.runId}</span>
                    <strong>{run.status}</strong>
                  </div>
                  <time dateTime={run.completedAt}>{formatTimestamp(run.completedAt)}</time>
                </header>
                <dl className="receipt__facts">
                  <div>
                    <dt>Model</dt>
                    <dd>{run.model}</dd>
                  </div>
                  <div>
                    <dt>Iterations</dt>
                    <dd>{run.iterations}</dd>
                  </div>
                  <div>
                    <dt>Tool calls</dt>
                    <dd>{run.toolCalls.length}</dd>
                  </div>
                </dl>
                {run.toolCalls.length === 0 ? (
                  <p className="receipt__empty">No repository tools were requested.</p>
                ) : (
                  <ul className="receipt__tools">
                    {run.toolCalls.map((tool) => (
                      <li key={tool.callId}>
                        <code>{tool.toolName}</code>
                        <span>{tool.policyCode}</span>
                        <span data-outcome={tool.outcome}>{tool.outcome}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {run.warnings.length === 0 ? null : (
                  <details className="receipt__warnings">
                    <summary>{run.warnings.length} warning{run.warnings.length === 1 ? "" : "s"}</summary>
                    <ul>
                      {run.warnings.map((warning, index) => (
                        <li key={`${warning}-${String(index)}`}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <details className="receipt__hashes">
                  <summary>Evidence fingerprints</summary>
                  <dl>
                    <div>
                      <dt>Input</dt>
                      <dd title={run.inputObjectSha256}>{shortHash(run.inputObjectSha256)}</dd>
                    </div>
                    <div>
                      <dt>Output</dt>
                      <dd title={run.outputObjectSha256}>{shortHash(run.outputObjectSha256)}</dd>
                    </div>
                  </dl>
                </details>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
