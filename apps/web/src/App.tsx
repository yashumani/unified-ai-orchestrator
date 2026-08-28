import { CapabilityPanel } from "./components/CapabilityPanel";
import { ChatSurface } from "./components/ChatSurface";
import { RepositoryStatus } from "./components/RepositoryStatus";
import { RunReceipts } from "./components/RunReceipts";
import { RuntimeStatus } from "./components/RuntimeStatus";
import { SignalSpine } from "./components/SignalSpine";
import { TrustPanel } from "./components/TrustPanel";
import { useOperatorData } from "./hooks/useOperatorData";

function formatLastUpdated(date: Date | null): string {
  if (date === null) {
    return "Checking live state";
  }
  return `Updated ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

export function App() {
  const operator = useOperatorData();
  const trustAction =
    operator.pendingAction === "grant" || operator.pendingAction === "revoke"
      ? operator.pendingAction
      : null;
  const runtimeNotice =
    operator.actionNotice?.action === "start" ? operator.actionNotice : null;
  const trustNotice =
    operator.actionNotice?.action === "grant" ||
    operator.actionNotice?.action === "revoke"
      ? operator.actionNotice
      : null;

  return (
    <div className="operator-shell">
      <a className="skip-link" href="#operator-chat">
        Skip to chat
      </a>
      <header className="masthead">
        <div className="masthead__identity">
          <p className="eyebrow">Yashu · local AI flight control</p>
          <h1>Unified operator console</h1>
          <p>Start local AI, set repository trust, ask for work, and inspect the receipt.</p>
        </div>
        <div className="masthead__instruments" aria-label="Console identity">
          <div>
            <span>Flight model</span>
            <strong>qwen3:4b</strong>
          </div>
          <div>
            <span>Control plane</span>
            <strong>Loopback only</strong>
          </div>
          <button
            className="refresh-button"
            type="button"
            onClick={() => {
              void operator.refresh();
            }}
            disabled={
              operator.runtime.loading ||
              operator.trust.loading ||
              operator.repository.loading
            }
          >
            <span aria-hidden="true">↻</span>
            Refresh all
          </button>
          <p className="last-updated" aria-live="polite">
            {formatLastUpdated(operator.lastUpdated)}
          </p>
        </div>
      </header>

      <main>
        <SignalSpine
          runtime={operator.runtime.data}
          trust={operator.trust.data}
          loading={operator.runtime.loading && operator.runtime.data === null}
        />

        <div className="control-grid">
          <aside className="control-column control-column--left" aria-label="Runtime and capability controls">
            <RuntimeStatus
              resource={operator.runtime}
              starting={operator.pendingAction === "start"}
              actionError={runtimeNotice?.kind === "error" ? runtimeNotice.message : null}
              actionMessage={runtimeNotice?.kind === "success" ? runtimeNotice.message : null}
              onStart={() => {
                void operator.start();
              }}
              onRetry={() => {
                void operator.refresh();
              }}
            />
            <CapabilityPanel
              resource={operator.capabilities}
              onRetry={() => {
                void operator.refresh();
              }}
            />
          </aside>

          <div id="operator-chat" className="control-grid__chat">
            <ChatSurface />
          </div>

          <aside className="control-column control-column--right" aria-label="Repository policy controls">
            <TrustPanel
              resource={operator.trust}
              pending={trustAction}
              actionError={trustNotice?.kind === "error" ? trustNotice.message : null}
              actionMessage={trustNotice?.kind === "success" ? trustNotice.message : null}
              onGrant={() => {
                void operator.grant();
              }}
              onRevoke={() => {
                void operator.revoke();
              }}
              onRetry={() => {
                void operator.refresh();
              }}
            />
            <RepositoryStatus
              resource={operator.repository}
              onRetry={() => {
                void operator.refresh();
              }}
            />
          </aside>
        </div>

        <RunReceipts
          resource={operator.runs}
          onRetry={() => {
            void operator.refresh();
          }}
        />
      </main>

      <footer className="operator-footer">
        <span>Unified AI Orchestrator · Phase 1</span>
        <span>No cloud credentials · No browser execution · No model downloads</span>
      </footer>
    </div>
  );
}
