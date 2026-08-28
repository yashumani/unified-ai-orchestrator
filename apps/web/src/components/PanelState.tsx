interface PanelStateProps {
  kind: "loading" | "error" | "empty";
  title: string;
  detail: string;
  onRetry?: () => void;
}

export function PanelState({
  kind,
  title,
  detail,
  onRetry
}: PanelStateProps) {
  return (
    <div className={`panel-state panel-state--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="panel-state__mark" aria-hidden="true">
        {kind === "loading" ? "···" : kind === "error" ? "!" : "○"}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
        {onRetry === undefined ? null : (
          <button className="text-button" type="button" onClick={onRetry}>
            Retry check
          </button>
        )}
      </div>
    </div>
  );
}
