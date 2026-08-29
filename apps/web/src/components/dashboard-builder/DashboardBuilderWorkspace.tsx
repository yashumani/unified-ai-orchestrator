import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent
} from "react";
import { useDashboardBuilder } from "../../hooks/useDashboardBuilder";
import { DashboardManifestEditor } from "./DashboardManifestEditor";
import { DashboardPreviewCanvas } from "./DashboardPreviewCanvas";
import { ManifestLineage } from "./ManifestLineage";

function friendly(value: string): string {
  return value.replaceAll("-", " ");
}

const ignoreDirtyChange = (_dirty: boolean) => undefined;

export function DashboardBuilderWorkspace({
  onDirtyChange = ignoreDirtyChange
}: {
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const builder = useDashboardBuilder();
  const { state } = builder;
  const uploadRef = useRef<HTMLInputElement>(null);
  const activeId = state.active?.template.templateId ?? null;
  const busy = state.pendingAction !== null || state.loading;
  const editorKey = `${activeId ?? "none"}:${String(state.active?.template.currentRevision ?? 0)}`;
  const [editorValid, setEditorValid] = useState(true);
  const confirmDiscard = useCallback(
    () =>
      !state.dirty ||
      window.confirm("Discard the unsaved dashboard changes and continue?"),
    [state.dirty]
  );

  useEffect(() => {
    onDirtyChange(state.dirty);
  }, [onDirtyChange, state.dirty]);

  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange]
  );

  useEffect(() => {
    setEditorValid(true);
  }, [editorKey]);

  useEffect(() => {
    if (!state.dirty) {
      return;
    }
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [state.dirty]);

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file !== undefined && confirmDiscard()) void builder.uploadFile(file);
  };

  return (
    <div className="dashboard-builder-workspace">
      <header className="dashboard-builder-hero">
        <div>
          <p className="eyebrow">Phase 3 · governed self-service analytics</p>
          <h1>Dashboard builder</h1>
          <p>
            Configure a strict template, preview six owned React components, and publish
            immutable revisions—without uploading application code or vendor assets.
          </p>
        </div>
        <div className="dashboard-builder-hero__actions">
          <button className="primary-button" type="button" disabled={busy} onClick={() => { if (confirmDiscard()) void builder.startFromSample(); }}>
            Start from sample
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => uploadRef.current?.click()}>
            Upload JSON
          </button>
          <button className="text-button" type="button" disabled={busy} onClick={() => void builder.downloadSample()}>
            Download sample
          </button>
          <input ref={uploadRef} className="dashboard-file-input" type="file" tabIndex={-1} aria-hidden="true" accept="application/json,.json" onChange={upload} />
        </div>
      </header>

      <ManifestLineage
        template={state.active}
        validation={state.validation}
        preview={state.preview}
        dirty={state.dirty}
      />

      {state.error === null ? null : (
        <div className="dashboard-notice dashboard-notice--error" role="alert">
          <strong>Action required</strong>
          <p>{state.error}</p>
          {state.conflictRevision === null ? null : (
            <p>Your changes are preserved. The server is now at event {state.conflictRevision}; refresh before saving again.</p>
          )}
        </div>
      )}
      {state.notice === null ? null : (
        <div className="dashboard-notice dashboard-notice--success" role="status">{state.notice}</div>
      )}

      <div className="dashboard-builder-layout">
        <aside className="dashboard-template-ledger" aria-labelledby="dashboard-template-ledger-title">
          <header>
            <div><p className="eyebrow">Template ledger</p><h2 id="dashboard-template-ledger-title">Drafts</h2></div>
            <button type="button" className="text-button" disabled={busy} onClick={() => { if (confirmDiscard()) void builder.refresh(); }}>Refresh</button>
          </header>
          {state.loading && state.templates.length === 0 ? <p>Loading governed templates…</p> : null}
          {state.templates.length === 0 && !state.loading ? (
            <div className="dashboard-ledger-empty"><span>01</span><p>Start from the tracked sample or upload a dashboard-template/v1 JSON file.</p></div>
          ) : (
            <ul>
              {state.templates.map((template) => (
                <li key={template.templateId}>
                  <button
                    type="button"
                    aria-pressed={template.templateId === activeId}
                    data-active={String(template.templateId === activeId)}
                    data-integrity={template.integrity}
                    disabled={busy || template.integrity === "blocked"}
                    onClick={() => { if (confirmDiscard()) void builder.selectTemplate(template.templateId); }}
                  >
                    <strong>{template.name}</strong>
                    <span>{template.templateId}</span>
                    <small>
                      event {template.currentRevision} · {template.activeRevisionNumber === null ? "draft only" : `revision ${String(template.activeRevisionNumber)}`}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <section className="dashboard-adapter-status" aria-labelledby="dashboard-adapter-title">
            <h3 id="dashboard-adapter-title">Data adapters</h3>
            {state.adapters.map((adapter) => (
              <div key={adapter.adapterId} data-status={adapter.status}>
                <span aria-hidden="true" />
                <div>
                  <strong>{adapter.label}</strong>
                  <small>{adapter.status}</small>
                  {adapter.diagnostics.length === 0 ? null : (
                    <ul className="dashboard-inline-diagnostics">
                      {adapter.diagnostics.map((diagnostic) => (
                        <li key={`${diagnostic.code}-${diagnostic.path}`}>
                          {diagnostic.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
            <p>Qlik stays unavailable until server-side tenant, app, authentication, and allowlist configuration is supplied.</p>
          </section>
        </aside>

        <section className="dashboard-builder-main" aria-label="Dashboard authoring surface">
          {state.active === null || state.draft === null ? (
            <div className="dashboard-builder-empty">
              <span aria-hidden="true">12</span>
              <h2>Choose a governed starting point</h2>
              <p>The tracked synthetic sample demonstrates parameters, calculations, table columns, filters, charts, layouts, and theme tokens.</p>
            </div>
          ) : (
            <>
              <section className="dashboard-authoring-panel">
                <header className="dashboard-authoring-panel__heading">
                  <div><p className="eyebrow">Authoring</p><h2>{state.draft.template.name}</h2></div>
                  <div className="dashboard-mode-switch" role="group" aria-label="Editor mode">
                    <button type="button" disabled={busy} aria-pressed={state.mode === "form"} onClick={() => builder.setMode("form")}>Form</button>
                    <button type="button" disabled={busy || !editorValid} aria-pressed={state.mode === "json"} onClick={() => builder.setMode("json")}>JSON</button>
                  </div>
                </header>
                <div className="dashboard-action-bar">
                  <span data-dirty={String(state.dirty)}>{state.dirty ? "Unsaved draft" : "Saved draft"}</span>
                  <button className="secondary-button" type="button" disabled={busy || !editorValid || !state.dirty || state.jsonError !== null || state.validation?.valid !== true} onClick={() => void builder.saveDraft()}>Save draft</button>
                  <button className="primary-button" type="button" disabled={busy || state.dirty || state.validation?.publishEligible !== true} onClick={() => void builder.publish()}>Publish revision</button>
                </div>

                {state.mode === "form" ? (
                  <DashboardManifestEditor key={editorKey} manifest={state.draft} disabled={busy} onBufferedChange={builder.markBufferedEdit} onValidityChange={setEditorValid} onChange={builder.replaceManifest} />
                ) : (
                  <div className="dashboard-json-editor">
                    <label htmlFor="dashboard-manifest-json">dashboard-template/v1 JSON</label>
                    <textarea id="dashboard-manifest-json" disabled={busy} spellCheck={false} value={state.jsonText} onChange={(event) => builder.setJsonText(event.target.value)} />
                    {state.jsonError === null ? <p>JSON is structurally valid.</p> : <p role="alert">{state.jsonError}</p>}
                  </div>
                )}
              </section>

              <section className="dashboard-diagnostics" aria-labelledby="dashboard-diagnostics-title">
                <header><div><p className="eyebrow">Validation</p><h2 id="dashboard-diagnostics-title">Diagnostics</h2></div><span>{state.validation?.diagnostics.length ?? 0}</span></header>
                {state.validation === null ? <p>Validation is waiting for a complete manifest.</p> : state.validation.diagnostics.length === 0 ? (
                  <p className="dashboard-diagnostics__clear">No schema, reference, calculation, layout, or publish blockers found.</p>
                ) : (
                  <ol>
                    {state.validation.diagnostics.map((diagnostic, index) => (
                      <li key={`${diagnostic.code}-${diagnostic.path}-${String(index)}`} data-severity={diagnostic.severity}>
                        <code>{diagnostic.path || "/"}</code>
                        <div><strong>{friendly(diagnostic.code)}</strong><p>{diagnostic.message}</p>{diagnostic.remediation === undefined ? null : <small>{diagnostic.remediation}</small>}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="dashboard-preview-panel" aria-labelledby="dashboard-preview-title">
                <header>
                  <div><p className="eyebrow">Bounded data execution</p><h2 id="dashboard-preview-title">React preview</h2></div>
                  <button type="button" className="secondary-button" disabled={busy || state.previewLoading || state.validation?.valid !== true} onClick={() => void builder.refreshPreview()}>Refresh preview</button>
                </header>
                {state.previewLoading ? <p className="dashboard-preview-message" role="status">Refreshing the validated draft preview…</p> : null}
                {state.preview === null ? <p className="dashboard-preview-message">Preview is waiting for a valid draft and an available adapter.</p> : (
                  <DashboardPreviewCanvas manifest={state.draft} preview={state.preview} onFilterChange={builder.changeFilter} />
                )}
              </section>

              <section className="dashboard-revision-ledger" aria-labelledby="dashboard-revisions-title">
                <header><div><p className="eyebrow">Immutable history</p><h2 id="dashboard-revisions-title">Published revisions</h2></div><span>{state.revisions.length}</span></header>
                {state.revisions.length === 0 ? <p>Publish the first verified fixture build to establish revision history.</p> : (
                  <ol>
                    {[...state.revisions].reverse().map((revision) => (
                      <li key={revision.revisionNumber}>
                        <div><strong>Revision {revision.revisionNumber}</strong><small>{friendly(revision.eventType)} · {new Date(revision.occurredAt).toLocaleString()}</small><code>{revision.manifestSha256.slice(0, 16)}</code></div>
                        <div>
                          <button type="button" className="text-button" disabled={busy} onClick={() => void builder.downloadRevision(revision.revisionNumber)}>Download</button>
                          <button type="button" className="secondary-button" disabled={busy || state.dirty || revision.revisionNumber === state.active?.template.activeRevisionNumber} onClick={() => void builder.rollback(revision.revisionNumber)}>Roll back</button>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
