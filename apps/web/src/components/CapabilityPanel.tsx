import type { WhiteShadowCapabilityFeed } from "../api";
import type { ResourceState } from "../hooks/useOperatorData";
import { PanelState } from "./PanelState";

interface CapabilityPanelProps {
  resource: ResourceState<WhiteShadowCapabilityFeed>;
  onRetry: () => void;
}

export function CapabilityPanel({ resource, onRetry }: CapabilityPanelProps) {
  const feed = resource.data;
  const capabilities = feed?.capabilities ?? null;

  return (
    <section className="panel capability-panel" aria-labelledby="capability-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">WhiteShadow</p>
          <h2 id="capability-title">Read-only capability feed</h2>
        </div>
        {capabilities === null ? null : (
          <span className="count-badge">{capabilities.length}</span>
        )}
      </div>

      {resource.loading && capabilities === null ? (
        <PanelState
          kind="loading"
          title="Reading capability catalog"
          detail="Only safe, model-free, read-only entries can appear here."
        />
      ) : null}
      {resource.error !== null && capabilities === null ? (
        <PanelState
          kind="error"
          title="Capability feed unavailable"
          detail="WhiteShadow may be offline. Ollama chat can continue in degraded mode."
          onRetry={onRetry}
        />
      ) : null}
      {feed !== null && !feed.available ? (
        <PanelState
          kind="error"
          title="Capability enrichment unavailable"
          detail={feed.status.detail}
          onRetry={onRetry}
        />
      ) : null}
      {feed?.available === true && capabilities?.length === 0 ? (
        <PanelState
          kind="empty"
          title="No safe capabilities reported"
          detail="WhiteShadow is ready but its safe read-only catalog is empty."
        />
      ) : null}
      {feed?.available !== true || capabilities === null || capabilities.length === 0 ? null : (
        <ul className="capability-list">
          {capabilities.map((capability) => (
            <li key={capability.capabilityId}>
              <div>
                <strong>{capability.name}</strong>
                <p>{capability.description}</p>
              </div>
              <span>safe · read only</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
