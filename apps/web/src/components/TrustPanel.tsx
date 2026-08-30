import type { TrustState } from "@unified-ai/contracts";
import type { ResourceState } from "../hooks/useOperatorData";
import { PanelState } from "./PanelState";

interface TrustPanelProps {
  resource: ResourceState<TrustState>;
  pending: "grant" | "revoke" | null;
  actionError: string | null;
  actionMessage: string | null;
  onGrant: () => void;
  onRevoke: () => void;
  onRetry: () => void;
}

export function TrustPanel({
  resource,
  pending,
  actionError,
  actionMessage,
  onGrant,
  onRevoke,
  onRetry
}: TrustPanelProps) {
  const trust = resource.data;

  return (
    <section className="panel trust-panel" aria-labelledby="trust-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Policy gate</p>
          <h2 id="trust-title">Workspace trust</h2>
        </div>
        {trust === null ? null : (
          <span className={`state-chip ${trust.trusted ? "state-chip--go" : "state-chip--hold"}`}>
            {trust.trusted ? "trusted" : "held"}
          </span>
        )}
      </div>

      {resource.loading && trust === null ? (
        <PanelState
          kind="loading"
          title="Checking policy"
          detail="Matching this repository and branch to its trust record."
        />
      ) : null}
      {resource.error !== null && trust === null ? (
        <PanelState
          kind="error"
          title="Trust state unavailable"
          detail={resource.error}
          onRetry={onRetry}
        />
      ) : null}
      {trust === null ? null : (
        <div className="trust-summary" aria-live="polite">
          <div className="trust-summary__branch">
            <span>Current branch</span>
            <code>{trust.identity.branch}</code>
          </div>
          <p>{trust.reason}</p>
          {trust.grant === null ? null : (
            <dl className="compact-data">
              <div>
                <dt>Grant</dt>
                <dd>Permanent, local</dd>
              </div>
              <div>
                <dt>Granted</dt>
                <dd>
                  <time dateTime={trust.grant.grantedAt}>
                    {new Date(trust.grant.grantedAt).toLocaleDateString()}
                  </time>
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}

      <div className="panel-actions">
        {trust?.trusted === true ? (
          <button
            className="secondary-button secondary-button--danger"
            type="button"
            onClick={onRevoke}
            disabled={pending !== null}
          >
            {pending === "revoke" ? "Revoking trust…" : "Revoke trust"}
          </button>
        ) : (
          <button
            className="primary-button"
            type="button"
            onClick={onGrant}
            disabled={
              trust === null || trust.identity.protectedBranch || pending !== null
            }
          >
            {pending === "grant" ? "Granting trust…" : "Grant permanent trust"}
          </button>
        )}
      </div>
      {actionError === null ? null : (
        <p className="action-note action-note--error" role="alert">
          {actionError}
        </p>
      )}
      {actionMessage === null ? null : (
        <p className="action-note action-note--success" role="status">
          {actionMessage}
        </p>
      )}
      <p className="panel-footnote">
        Trust permits governed repository tools on allowed development branches. It does not bypass policy.
      </p>
    </section>
  );
}
