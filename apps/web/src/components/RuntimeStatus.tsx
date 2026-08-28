import type { RuntimeServiceState, RuntimeStatus as RuntimeStatusType } from "@unified-ai/contracts";
import type { ResourceState } from "../hooks/useOperatorData";
import { PanelState } from "./PanelState";

interface RuntimeStatusProps {
  resource: ResourceState<RuntimeStatusType>;
  starting: boolean;
  actionError: string | null;
  actionMessage: string | null;
  onStart: () => void;
  onRetry: () => void;
}

function serviceLabel(service: RuntimeServiceState["service"]): string {
  return service === "ollama" ? "Ollama" : "WhiteShadow";
}

function ServiceRow({ service }: { service: RuntimeServiceState }) {
  return (
    <li className="service-row" data-phase={service.phase}>
      <span className="phase-dot" aria-hidden="true" />
      <div className="service-row__copy">
        <div>
          <strong>{serviceLabel(service.service)}</strong>
          <span className="phase-label">{service.phase}</span>
        </div>
        <p>{service.detail}</p>
        <time dateTime={service.checkedAt}>
          Checked {new Date(service.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>
    </li>
  );
}

export function RuntimeStatus({
  resource,
  starting,
  actionError,
  actionMessage,
  onStart,
  onRetry
}: RuntimeStatusProps) {
  const runtime = resource.data;
  const needsStart =
    runtime === null ||
    runtime.ollama.phase !== "ready" ||
    runtime.whiteshadow.phase !== "ready";

  return (
    <section className="panel runtime-panel" aria-labelledby="runtime-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Local AI</p>
          <h2 id="runtime-title">Runtime</h2>
        </div>
        <span className="model-tag">qwen3:4b</span>
      </div>

      {resource.loading && runtime === null ? (
        <PanelState
          kind="loading"
          title="Checking local services"
          detail="Reading Ollama and WhiteShadow status."
        />
      ) : null}
      {resource.error !== null && runtime === null ? (
        <PanelState
          kind="error"
          title="Runtime status unavailable"
          detail={resource.error}
          onRetry={onRetry}
        />
      ) : null}
      {runtime === null ? null : (
        <ul className="service-list" aria-live="polite">
          <ServiceRow service={runtime.ollama} />
          <ServiceRow service={runtime.whiteshadow} />
        </ul>
      )}

      <div className="panel-actions">
        <button
          className="primary-button"
          type="button"
          onClick={onStart}
          disabled={starting || (!needsStart && runtime !== null)}
        >
          {starting
            ? "Starting local AI…"
            : !needsStart && runtime !== null
              ? "Local AI ready"
              : "Start local AI"}
        </button>
        <button className="text-button" type="button" onClick={onRetry} disabled={resource.loading}>
          Refresh status
        </button>
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
        Startup checks existing local services. It never downloads or changes a model.
      </p>
    </section>
  );
}
