import { CopilotChat, useDefaultRenderTool } from "@copilotkit/react-core/v2";
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { ToolCard } from "./ToolCard";

class ChatErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // CopilotKit errors are reduced to safe operator copy below.
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="chat-fallback" role="alert">
          <span aria-hidden="true">!</span>
          <h3>Chat could not connect</h3>
          <p>Confirm the local API is running, then reload this page.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function GovernedChat() {
  const [chatError, setChatError] = useState(false);

  useDefaultRenderTool(
    {
      render: ({ name, parameters, status, result }) => (
        <ToolCard
          name={name}
          parameters={parameters}
          status={status}
          {...(result === undefined ? {} : { result })}
        />
      )
    },
    []
  );

  return (
    <>
      {chatError ? (
        <p className="chat-error" role="alert">
          Chat connection failed. Check the local API, then try the request again.
        </p>
      ) : null}
      <CopilotChat
        agentId="default"
        className="operator-chat"
        attachments={{ enabled: false }}
        labels={{
          chatInputPlaceholder: "Ask the local agent to inspect this repository…",
          welcomeMessageText: "What do you want to inspect?",
          chatDisclaimerText:
            "Requests run through server policy. The browser cannot execute tools."
        }}
        onError={() => {
          setChatError(true);
        }}
      />
    </>
  );
}

export function ChatSurface() {
  return (
    <section className="chat-panel" aria-labelledby="chat-title">
      <div className="chat-panel__heading">
        <div>
          <p className="eyebrow">Governed channel</p>
          <h2 id="chat-title">Talk to the local agent</h2>
        </div>
        <span className="local-only-tag">local only</span>
      </div>
      <div className="chat-panel__body">
        <ChatErrorBoundary>
          <GovernedChat />
        </ChatErrorBoundary>
      </div>
    </section>
  );
}
