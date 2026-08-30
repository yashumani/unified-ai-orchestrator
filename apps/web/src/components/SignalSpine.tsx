import type { RuntimeServicePhase, RuntimeStatus, TrustState } from "@unified-ai/contracts";

interface SignalSpineProps {
  runtime: RuntimeStatus | null;
  trust: TrustState | null;
  loading: boolean;
}

type SignalPhase = RuntimeServicePhase | "checking" | "held" | "trusted";

function phaseLabel(phase: SignalPhase): string {
  if (phase === "ready") return "ready";
  if (phase === "trusted") return "trust active";
  if (phase === "held") return "trust held";
  return phase;
}

function SignalNode({
  sequence,
  eyebrow,
  title,
  detail,
  phase
}: {
  sequence: string;
  eyebrow: string;
  title: string;
  detail: string;
  phase: SignalPhase;
}) {
  return (
    <li className="signal-node" data-phase={phase}>
      <div className="signal-node__index" aria-hidden="true">
        {sequence}
      </div>
      <div className="signal-node__beacon" aria-hidden="true">
        <span />
      </div>
      <div className="signal-node__copy">
        <span className="signal-node__eyebrow">{eyebrow}</span>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <span className="signal-node__phase">{phaseLabel(phase)}</span>
    </li>
  );
}

export function SignalSpine({ runtime, trust, loading }: SignalSpineProps) {
  const ollamaPhase: SignalPhase = loading
    ? "checking"
    : (runtime?.ollama.phase ?? "offline");
  const whiteShadowPhase: SignalPhase = loading
    ? "checking"
    : (runtime?.whiteshadow.phase ?? "offline");
  const policyPhase: SignalPhase = loading
    ? "checking"
    : trust?.trusted === true
      ? "trusted"
      : "held";

  return (
    <section className="signal-spine" aria-labelledby="signal-spine-title">
      <div className="signal-spine__heading">
        <div>
          <p className="eyebrow">Live signal spine</p>
          <h2 id="signal-spine-title">Local request path</h2>
        </div>
        <p>One governed route. The browser has no execution authority.</p>
      </div>
      <ol className="signal-spine__track" aria-label="Ollama to policy to WhiteShadow signal path">
        <SignalNode
          sequence="01"
          eyebrow="Input"
          title="Ollama"
          detail="qwen3:4b"
          phase={ollamaPhase}
        />
        <SignalNode
          sequence="02"
          eyebrow="Govern"
          title="Orchestrator / policy"
          detail="repository boundary"
          phase={policyPhase}
        />
        <SignalNode
          sequence="03"
          eyebrow="Enrich"
          title="WhiteShadow"
          detail="safe read-only capabilities"
          phase={whiteShadowPhase}
        />
      </ol>
    </section>
  );
}
