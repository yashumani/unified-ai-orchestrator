import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import type { PortfolioResource } from "../hooks/usePortfolioData";
import { usePortfolioData } from "../hooks/usePortfolioData";
import type {
  ChatImportBody,
  ChatImportResponse,
  PortfolioCitation,
  PortfolioCluster,
  PortfolioOverrideReasonCode,
  PortfolioRecommendation,
  PortfolioRecommendationAction,
  PortfolioRepository,
  PortfolioRun,
  RecommendationOverrideBody,
  RecommendationOverrideResponse
} from "../portfolio-types";
import {
  PORTFOLIO_OVERRIDE_REASON_CODES,
  PORTFOLIO_RECOMMENDATION_ACTIONS
} from "../portfolio-types";

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function actionLabel(action: string): string {
  return action.replaceAll("-", " ");
}

function isIntegrityMessage(message: string): boolean {
  return /integrity|checksum|sha-?256|corrupt/iu.test(message);
}

function errorsFrom(resources: Array<PortfolioResource<unknown>>): string[] {
  return resources.flatMap((resource) =>
    resource.error === null ? [] : [resource.error]
  );
}

function PortfolioStateNotice({
  state,
  title,
  detail
}: {
  state: "loading" | "empty" | "incomplete" | "degraded" | "integrity";
  title: string;
  detail: string;
}) {
  return (
    <div
      className={`portfolio-state portfolio-state--${state}`}
      data-portfolio-state={state}
      role={state === "integrity" || state === "degraded" ? "alert" : "status"}
    >
      <span aria-hidden="true">
        {state === "loading"
          ? "···"
          : state === "integrity"
            ? "!"
            : state === "empty"
              ? "○"
              : "△"}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function CoverageRail({
  label,
  value,
  tone = "evidence"
}: {
  label: string;
  value: number;
  tone?: "evidence" | "chat" | "confidence";
}) {
  const bounded = Math.max(0, Math.min(1, value));
  return (
    <div className="coverage-rail" data-tone={tone}>
      <div>
        <span>{label}</span>
        <strong>{percent(bounded)}</strong>
      </div>
      <meter min="0" max="1" value={bounded} aria-label={`${label} ${percent(bounded)}`} />
    </div>
  );
}

function RepositoryProfiles({ repositories }: { repositories: PortfolioRepository[] }) {
  return (
    <section className="portfolio-panel portfolio-profiles" id="portfolio-profiles">
      <header className="portfolio-panel__heading">
        <div>
          <p className="eyebrow">Captured at immutable revisions</p>
          <h3>Repository profiles</h3>
        </div>
        <span className="count-badge">{repositories.length}</span>
      </header>
      {repositories.length === 0 ? (
        <p className="portfolio-inline-empty">Profiles appear after a completed capture.</p>
      ) : (
        <div className="profile-ledger">
          {repositories.map((repository) => (
            <article className="profile-record" key={repository.repositoryId}>
              <div className="profile-record__rail" aria-hidden="true" />
              <div className="profile-record__body">
                <header>
                  <div>
                    <span className="portfolio-kicker">{repository.visibility}</span>
                    <h4>{repository.fullName}</h4>
                  </div>
                  {repository.recommendationAction === undefined ? null : (
                    <span className="portfolio-action">
                      {actionLabel(repository.recommendationAction)}
                    </span>
                  )}
                </header>
                <p>{repository.purpose}</p>
                <div className="coverage-pair">
                  <CoverageRail label="Evidence" value={repository.evidenceCoverage} />
                  <CoverageRail label="Chat intent" value={repository.chatCoverage} tone="chat" />
                </div>
                <div className="tag-row" aria-label="Capabilities">
                  {repository.capabilities.map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
                <details>
                  <summary>Revision and technology</summary>
                  <code>{repository.capturedRevision}</code>
                  <div className="tag-row tag-row--technology">
                    {repository.technologyTags.map((technology) => (
                      <span key={technology}>{technology}</span>
                    ))}
                  </div>
                </details>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function OverlapClusters({ clusters }: { clusters: PortfolioCluster[] }) {
  return (
    <section className="portfolio-panel" id="portfolio-clusters">
      <header className="portfolio-panel__heading">
        <div>
          <p className="eyebrow">Shared capability map</p>
          <h3>Overlap clusters</h3>
        </div>
        <span className="count-badge">{clusters.length}</span>
      </header>
      {clusters.length === 0 ? (
        <p className="portfolio-inline-empty">No evidence-backed overlap is available yet.</p>
      ) : (
        <ol className="cluster-list">
          {clusters.map((cluster) => (
            <li key={cluster.clusterId}>
              <span className="cluster-list__node" aria-hidden="true" />
              <article>
                <h4>{cluster.label}</h4>
                <p>{cluster.rationale}</p>
                <div className="tag-row">
                  {cluster.sharedCapabilities.map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
                <dl className="portfolio-facts">
                  <div>
                    <dt>Repositories</dt>
                    <dd>{cluster.repositoryIds.length}</dd>
                  </div>
                  <div>
                    <dt>Citations</dt>
                    <dd>{cluster.citationIds.length}</dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function OverrideForm({
  recommendation,
  onOverride
}: {
  recommendation: PortfolioRecommendation;
  onOverride: (
    recommendationId: string,
    body: RecommendationOverrideBody
  ) => Promise<RecommendationOverrideResponse>;
}) {
  const [action, setAction] = useState<PortfolioRecommendationAction>(
    recommendation.eligibleActions[0] ?? recommendation.action
  );
  const [reasonCode, setReasonCode] =
    useState<PortfolioOverrideReasonCode>("missing-context");
  const [explanation, setExplanation] = useState(
    "Reviewed against repository evidence."
  );
  const [providedBy, setProvidedBy] = useState("yashu");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    try {
      const response = await onOverride(recommendation.recommendationId, {
        action,
        reasonCode,
        explanation,
        providedBy
      });
      setNotice(`Override recorded as ${actionLabel(response.action)}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Override could not be recorded.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="override-form"
      data-override-for={recommendation.recommendationId}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label>
        Replacement action
        <select
          name="action"
          value={action}
          onChange={(event) => {
            setAction(event.target.value as PortfolioRecommendationAction);
          }}
        >
          {PORTFOLIO_RECOMMENDATION_ACTIONS.map((eligibleAction) => (
            <option key={eligibleAction} value={eligibleAction}>
              {actionLabel(eligibleAction)}
              {recommendation.eligibleActions.includes(eligibleAction)
                ? " · rule eligible"
                : " · human override"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reason code
        <select
          name="reasonCode"
          value={reasonCode}
          onChange={(event) => {
            setReasonCode(event.target.value as PortfolioOverrideReasonCode);
          }}
        >
          {PORTFOLIO_OVERRIDE_REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {actionLabel(code)}
            </option>
          ))}
        </select>
      </label>
      <label className="override-form__wide">
        Explanation
        <textarea
          name="explanation"
          rows={2}
          value={explanation}
          onChange={(event) => {
            setExplanation(event.target.value);
          }}
          required
        />
      </label>
      <label>
        Provided by
        <input
          name="providedBy"
          value={providedBy}
          onChange={(event) => {
            setProvidedBy(event.target.value);
          }}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          required
        />
      </label>
      <button className="secondary-button" type="submit" disabled={pending}>
        {pending ? "Recording override…" : "Record override"}
      </button>
      {notice === null ? null : (
        <p className="portfolio-form-notice" role="status">
          {notice}
        </p>
      )}
    </form>
  );
}

function Recommendations({
  recommendations,
  onOverride
}: {
  recommendations: PortfolioRecommendation[];
  onOverride: (
    recommendationId: string,
    body: RecommendationOverrideBody
  ) => Promise<RecommendationOverrideResponse>;
}) {
  return (
    <section className="portfolio-panel portfolio-recommendations" id="portfolio-recommendations">
      <header className="portfolio-panel__heading">
        <div>
          <p className="eyebrow">Cited decision candidates</p>
          <h3>Recommendations</h3>
        </div>
        <span className="count-badge">{recommendations.length}</span>
      </header>
      {recommendations.length === 0 ? (
        <p className="portfolio-inline-empty">Recommendations require cited repository evidence.</p>
      ) : (
        <div className="recommendation-list">
          {recommendations.map((recommendation) => (
            <article className="recommendation-record" key={recommendation.recommendationId}>
              <header>
                <div>
                  <span className="portfolio-kicker">{recommendation.lifecycle}</span>
                  <h4>{actionLabel(recommendation.action)}</h4>
                </div>
                <span className="portfolio-confidence">
                  {percent(recommendation.confidence.weightedConfidence)}
                </span>
              </header>
              <p>{recommendation.rationale}</p>
              <CoverageRail
                label="Weighted confidence"
                value={recommendation.confidence.weightedConfidence}
                tone="confidence"
              />
              <dl className="confidence-factors" aria-label="Confidence factors">
                <div>
                  <dt>Coverage</dt>
                  <dd>{percent(recommendation.confidence.coverage)}</dd>
                </div>
                <div>
                  <dt>Citations</dt>
                  <dd>{percent(recommendation.confidence.citations)}</dd>
                </div>
                <div>
                  <dt>Classifier agreement</dt>
                  <dd>{percent(recommendation.confidence.classifierAgreement)}</dd>
                </div>
                <div>
                  <dt>Rule support</dt>
                  <dd>{percent(recommendation.confidence.ruleSupport)}</dd>
                </div>
              </dl>
              <dl className="portfolio-facts">
                <div>
                  <dt>Repositories</dt>
                  <dd>{recommendation.repositoryIds.length}</dd>
                </div>
                <div>
                  <dt>Citations</dt>
                  <dd>{recommendation.citationIds.length}</dd>
                </div>
                <div>
                  <dt>Contradictions</dt>
                  <dd>{recommendation.contradictions.length}</dd>
                </div>
              </dl>
              <details>
                <summary>Override this recommendation</summary>
                <OverrideForm recommendation={recommendation} onOverride={onOverride} />
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function EvidenceReview({ repositories }: { repositories: PortfolioRepository[] }) {
  const evidenceRows = repositories.flatMap((repository) =>
    repository.citations.map((citation) => ({ repository, citation }))
  );
  const contradictionRows = repositories.flatMap((repository) =>
    repository.contradictions.map((contradiction) => ({
      repository,
      contradiction
    }))
  );

  return (
    <section className="portfolio-panel portfolio-evidence" id="portfolio-evidence">
      <header className="portfolio-panel__heading">
        <div>
          <p className="eyebrow">Evidence stays visible</p>
          <h3>Evidence &amp; contradictions</h3>
        </div>
        <span className="count-badge">{evidenceRows.length}</span>
      </header>
      <div className="evidence-columns">
        <div>
          <h4>Citations</h4>
          {evidenceRows.length === 0 ? (
            <p className="portfolio-inline-empty">No sanitized citations are available.</p>
          ) : (
            <ul className="evidence-list">
              {evidenceRows.map(({ repository, citation }) => (
                <CitationRow
                  citation={citation}
                  repositoryName={repository.fullName}
                  key={`${repository.repositoryId}:${citation.citationId}`}
                />
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>Contradictions</h4>
          {contradictionRows.length === 0 ? (
            <p className="portfolio-inline-empty">No explicit contradictions are recorded.</p>
          ) : (
            <ul className="contradiction-list">
              {contradictionRows.map(({ repository, contradiction }) => (
                <li key={`${repository.repositoryId}:${contradiction}`}>
                  <strong>{repository.fullName}</strong>
                  <p>{contradiction}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function CitationRow({
  citation,
  repositoryName
}: {
  citation: PortfolioCitation;
  repositoryName: string;
}) {
  return (
    <li>
      <span>{citation.family}</span>
      <strong>{citation.statement}</strong>
      <small>{repositoryName}</small>
      <code>{citation.locator}</code>
    </li>
  );
}

function ChatImport({
  onImport
}: {
  onImport: (body: ChatImportBody) => Promise<ChatImportResponse>;
}) {
  const [projectId, setProjectId] = useState("");
  const [conversations, setConversations] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) {
      return;
    }
    try {
      setConversations(await file.text());
      setNotice(`Selected ${file.name}. Review the project ID, then import.`);
    } catch {
      setNotice("The selected file could not be read.");
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(conversations) as unknown;
    } catch {
      setNotice("Enter valid ChatGPT export JSON. Nothing was imported.");
      return;
    }

    setPending(true);
    try {
      const response = await onImport({ projectId, conversations: parsed });
      setNotice(
        `Imported ${String(response.importedCount)} conversations · receipt ${response.receiptId}`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The import could not be completed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="portfolio-panel portfolio-import" id="portfolio-import">
      <header className="portfolio-panel__heading">
        <div>
          <p className="eyebrow">Optional intent enrichment</p>
          <h3>ChatGPT JSON import</h3>
        </div>
        <span className="state-chip">Atomic</span>
      </header>
      <p>
        Import a ChatGPT project export as intent evidence. Invalid JSON is rejected before any conversation is stored.
      </p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          Project ID
          <input
            name="projectId"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
            }}
            placeholder="app-development"
            required
          />
        </label>
        <label>
          Select export file
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              void chooseFile(event);
            }}
          />
        </label>
        <label className="portfolio-import__json">
          Conversations JSON
          <textarea
            name="conversations"
            rows={5}
            value={conversations}
            onChange={(event) => {
              setConversations(event.target.value);
            }}
            placeholder='[{"id":"conversation-1"}]'
            required
          />
        </label>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "Importing…" : "Import ChatGPT JSON"}
        </button>
      </form>
      {notice === null ? null : (
        <p className="portfolio-form-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

function RunHistory({ runs }: { runs: PortfolioRun[] }) {
  return (
    <section className="portfolio-panel portfolio-history" id="portfolio-history">
      <header className="portfolio-panel__heading">
        <div>
          <p className="eyebrow">Immutable checkpoints</p>
          <h3>Run history</h3>
        </div>
        <span className="count-badge">{runs.length}</span>
      </header>
      {runs.length === 0 ? (
        <p className="portfolio-inline-empty">No run receipts are available.</p>
      ) : (
        <div className="run-table-wrap">
          <table className="run-table">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Status</th>
                <th scope="col">Captured</th>
                <th scope="col">Complete</th>
                <th scope="col">Incomplete</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <th scope="row">
                    <code>{run.runId}</code>
                    <small>{dateTime(run.createdAt)}</small>
                  </th>
                  <td>
                    <span className="portfolio-status" data-status={run.status}>
                      {run.status}
                    </span>
                  </td>
                  <td>{run.repositoryCount}</td>
                  <td>{run.completeCount}</td>
                  <td>{run.incompleteCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function PortfolioDashboard() {
  const portfolio = usePortfolioData();
  const [startNotice, setStartNotice] = useState<string | null>(null);
  const resources: Array<PortfolioResource<unknown>> = [
    portfolio.runs,
    portfolio.repositories,
    portfolio.clusters,
    portfolio.recommendations
  ];
  const errors = errorsFrom(resources);
  const integrityErrors = errors.filter(isIntegrityMessage);
  const runs = portfolio.runs.data ?? [];
  const repositories = portfolio.repositories.data ?? [];
  const clusters = portfolio.clusters.data ?? [];
  const recommendations = portfolio.recommendations.data ?? [];
  const currentRun = runs[0];
  const initiallyLoading = resources.every(
    (resource) => resource.loading && resource.data === null
  );
  const empty =
    !initiallyLoading &&
    errors.length === 0 &&
    runs.length === 0 &&
    repositories.length === 0 &&
    clusters.length === 0 &&
    recommendations.length === 0;
  const incomplete =
    (currentRun?.incompleteCount ?? 0) > 0 ||
    repositories.some((repository) => repository.evidenceCoverage < 1);
  const degraded =
    errors.some((error) => !isIntegrityMessage(error)) ||
    (currentRun?.warnings.length ?? 0) > 0 ||
    currentRun?.status === "degraded" ||
    currentRun?.status === "paused" ||
    currentRun?.status === "cancelled" ||
    currentRun?.status === "deferred" ||
    currentRun?.status === "failed";
  const totalCitations = useMemo(
    () => repositories.reduce((total, repository) => total + repository.citations.length, 0),
    [repositories]
  );
  const totalContradictions = useMemo(
    () =>
      repositories.reduce(
        (total, repository) => total + repository.contradictions.length,
        0
      ),
    [repositories]
  );
  const clusteredRepositoryIds = useMemo(
    () => new Set(clusters.flatMap((cluster) => cluster.repositoryIds)),
    [clusters]
  );
  const standaloneCount = repositories.filter(
    (repository) => !clusteredRepositoryIds.has(repository.repositoryId)
  ).length;

  const start = async () => {
    setStartNotice(null);
    try {
      const response = await portfolio.start();
      setStartNotice(`Portfolio run ${response.runId} is ${response.status}.`);
    } catch (error) {
      setStartNotice(error instanceof Error ? error.message : "The portfolio run could not start.");
    }
  };

  return (
    <section className="portfolio-workspace" aria-labelledby="portfolio-title">
      <header className="portfolio-hero">
        <div>
          <p className="eyebrow">Phase 2 · read-only rationalization</p>
          <h2 id="portfolio-title">Portfolio Overview</h2>
          <p>
            Compare purpose, capability overlap, and cited evidence before any repository is combined, adopted, or archived.
          </p>
        </div>
        <div className="portfolio-hero__actions">
          <button
            className="primary-button"
            type="button"
            disabled={portfolio.starting}
            onClick={() => {
              void start();
            }}
          >
            {portfolio.starting ? "Starting…" : "Start portfolio run"}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={portfolio.refreshing}
            onClick={() => {
              void portfolio.refresh();
            }}
          >
            {portfolio.refreshing ? "Refreshing…" : "Refresh portfolio"}
          </button>
          <p aria-live="polite">
            {startNotice ??
              (portfolio.lastUpdated === null
                ? "Checking immutable evidence"
                : `Updated ${portfolio.lastUpdated.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}`)}
          </p>
        </div>
      </header>

      <nav className="portfolio-nav" aria-label="Portfolio views">
        <a href="#portfolio-profiles">Profiles</a>
        <a href="#portfolio-clusters">Clusters</a>
        <a href="#portfolio-recommendations">Recommendations</a>
        <a href="#portfolio-evidence">Evidence</a>
        <a href="#portfolio-import">ChatGPT import</a>
        <a href="#portfolio-history">Run history</a>
      </nav>

      {initiallyLoading ? (
        <PortfolioStateNotice
          state="loading"
          title="Loading portfolio evidence"
          detail="Reading sanitized profiles, clusters, recommendations, and immutable run history."
        />
      ) : null}
      {empty ? (
        <PortfolioStateNotice
          state="empty"
          title="No portfolio run yet"
          detail="Start portfolio run to capture the current repository inventory and build cited profiles."
        />
      ) : null}
      {integrityErrors.length > 0 ? (
        <PortfolioStateNotice
          state="integrity"
          title="Integrity check failed"
          detail={integrityErrors.join(" ")}
        />
      ) : null}
      {incomplete ? (
        <PortfolioStateNotice
          state="incomplete"
          title="Incomplete evidence"
          detail={`${String(currentRun?.incompleteCount ?? 0)} repositories need additional access or citations before auto-finalization.`}
        />
      ) : null}
      {degraded ? (
        <PortfolioStateNotice
          state="degraded"
          title="Degraded enrichment"
          detail={
            errors.filter((error) => !isIntegrityMessage(error)).join(" ") ||
            currentRun?.warnings.join(" ") ||
            "Deterministic profiles remain available while optional enrichment is limited."
          }
        />
      ) : null}

      <div className="portfolio-summary" aria-label="Portfolio summary">
        <div>
          <span>Inventory</span>
          <strong>{currentRun?.repositoryCount ?? repositories.length} repositories</strong>
        </div>
        <div>
          <span>Complete profiles</span>
          <strong>{currentRun?.completeCount ?? 0}</strong>
        </div>
        <div>
          <span>Sanitized citations</span>
          <strong>{totalCitations}</strong>
        </div>
        <div>
          <span>Contradictions</span>
          <strong>{totalContradictions}</strong>
        </div>
        <div>
          <span>Standalone profiles</span>
          <strong>{standaloneCount}</strong>
        </div>
        <div>
          <span>Source refs</span>
          <strong>
            {(currentRun?.revisionMismatchCount ?? 0) === 0
              ? "unchanged"
              : `${String(currentRun?.revisionMismatchCount)} mismatches`}
          </strong>
        </div>
      </div>

      <div className="portfolio-layout">
        <RepositoryProfiles repositories={repositories} />
        <OverlapClusters clusters={clusters} />
        <Recommendations
          recommendations={recommendations}
          onOverride={portfolio.overrideRecommendation}
        />
        <EvidenceReview repositories={repositories} />
        <ChatImport onImport={portfolio.importChats} />
        <RunHistory runs={runs} />
      </div>
    </section>
  );
}
