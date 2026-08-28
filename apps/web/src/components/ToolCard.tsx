interface ToolCardProps {
  name: string;
  parameters: unknown;
  status: string;
  result?: string;
}

interface ToolResultSummary {
  ok: boolean | null;
  policy: string;
  summary: string;
  truncated: boolean;
}

const DISPLAY_ARGUMENTS = new Set([
  "path",
  "query",
  "glob",
  "pattern",
  "script",
  "startLine",
  "lineCount",
  "maxEntries",
  "maxResults",
  "expectedOccurrences"
]);

function boundedValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  }
  if (value === null) {
    return "null";
  }
  return "[structured value]";
}

export function safeParameterRows(
  parameters: unknown
): Array<{ key: string; value: string }> {
  if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
    return [];
  }
  return Object.entries(parameters)
    .slice(0, 12)
    .map(([key, value]) => ({
      key,
      value: DISPLAY_ARGUMENTS.has(key) ? boundedValue(value) : "[not displayed]"
    }));
}

export function parseToolResult(result: string | undefined): ToolResultSummary {
  if (result === undefined) {
    return {
      ok: null,
      policy: "pending",
      summary: "Waiting for the governed server result.",
      truncated: false
    };
  }
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      return {
        ok: typeof record["ok"] === "boolean" ? record["ok"] : null,
        policy:
          typeof record["policy"] === "string" ? record["policy"] : "recorded",
        summary:
          typeof record["summary"] === "string"
            ? record["summary"].slice(0, 320)
            : "The governed server returned a result.",
        truncated: record["truncated"] === true
      };
    }
  } catch {
    // Never print an unstructured tool result into the browser surface.
  }
  return {
    ok: null,
    policy: "recorded",
    summary: "The governed server returned a bounded result.",
    truncated: false
  };
}

export function ToolCard({ name, parameters, status, result }: ToolCardProps) {
  const parameterRows = safeParameterRows(parameters);
  const summary = parseToolResult(result);
  const complete = status === "complete";

  return (
    <article className="tool-card" data-status={status} aria-label={`${name} tool call`}>
      <header>
        <div>
          <span className="tool-card__eyebrow">Policy-routed tool</span>
          <strong>{name}</strong>
        </div>
        <span className="tool-card__status">
          {complete ? (summary.ok === false ? "failed" : "complete") : "running"}
        </span>
      </header>
      {parameterRows.length === 0 ? null : (
        <details>
          <summary>Inspect bounded arguments</summary>
          <dl>
            {parameterRows.map((row) => (
              <div key={row.key}>
                <dt>{row.key}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <div className="tool-card__result" aria-live="polite">
        <span>Policy: {summary.policy}</span>
        <p>{summary.summary}</p>
        {summary.truncated ? <small>Result was bounded by the server.</small> : null}
      </div>
    </article>
  );
}
