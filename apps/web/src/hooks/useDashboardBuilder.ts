import {
  DASHBOARD_MAX_UPLOAD_BYTES,
  DashboardManifestSchema,
  DashboardValidationResultSchema,
  type DashboardManifest,
  type DashboardPreviewRequest
} from "@unified-ai/contracts/dashboard-builder";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  DashboardBuilderApiError,
  downloadDashboardRevision,
  downloadDashboardSample,
  getDashboardTemplate,
  importDashboardManifest,
  listDashboardAdapters,
  listDashboardRevisions,
  listDashboardTemplates,
  previewDashboard,
  publishDashboard,
  rollbackDashboard,
  updateDashboardDraft,
  validateDashboardDraft,
  type DashboardManifestDownload
} from "../dashboard-builder-api";
import {
  dashboardBuilderReducer,
  initialDashboardBuilderState,
  type DashboardEditorMode
} from "./dashboardBuilderReducer";

const LAST_TEMPLATE_KEY = "unified-ai.dashboard-builder.last-template";
const LOCAL_ACTOR = "local-operator";

function message(error: unknown): string {
  if (error instanceof DashboardBuilderApiError || error instanceof Error) {
    return error.message;
  }
  return "The dashboard operation could not be completed.";
}

function saveDownload(download: DashboardManifestDownload): void {
  const url = URL.createObjectURL(
    new Blob([download.json], { type: "application/json;charset=utf-8" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = download.fileName;
  anchor.rel = "noopener";
  anchor.click();
  URL.revokeObjectURL(url);
}

function defaultParameterValues(
  manifest: DashboardManifest
): DashboardPreviewRequest["parameterValues"] {
  return Object.fromEntries(
    manifest.parameters.map((parameter) => [
      parameter.parameterId,
      parameter.defaultValue
    ])
  );
}

export function useDashboardBuilder() {
  const [state, dispatch] = useReducer(
    dashboardBuilderReducer,
    initialDashboardBuilderState
  );
  const templateLoadSequence = useRef(0);
  const validationSequence = useRef(0);
  const previewSequence = useRef(0);

  const refreshTemplates = useCallback(async () => {
    const response = await listDashboardTemplates();
    dispatch({ type: "templates-replaced", templates: response.items });
    return response.items;
  }, []);

  const selectTemplate = useCallback(async (templateId: string) => {
    const requestId = ++templateLoadSequence.current;
    validationSequence.current += 1;
    previewSequence.current += 1;
    dispatch({ type: "template-loading" });
    try {
      const [response, revisions] = await Promise.all([
        getDashboardTemplate(templateId),
        listDashboardRevisions(templateId)
      ]);
      if (requestId !== templateLoadSequence.current) {
        return;
      }
      localStorage.setItem(LAST_TEMPLATE_KEY, templateId);
      dispatch({
        type: "template-loaded",
        response,
        revisions: revisions.items
      });
    } catch (error) {
      if (requestId === templateLoadSequence.current) {
        dispatch({ type: "workspace-failed", message: message(error) });
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const [templates, adapters] = await Promise.all([
          listDashboardTemplates(controller.signal),
          listDashboardAdapters(controller.signal)
        ]);
        if (cancelled) {
          return;
        }
        dispatch({
          type: "workspace-loaded",
          templates: templates.items,
          adapters: adapters.items
        });
        const remembered = localStorage.getItem(LAST_TEMPLATE_KEY);
        const selected =
          templates.items.find((item) => item.templateId === remembered && item.integrity === "verified") ??
          templates.items.find((item) => item.integrity === "verified");
        if (selected !== undefined) {
          await selectTemplate(selected.templateId);
        }
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
          dispatch({ type: "workspace-failed", message: message(error) });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      templateLoadSequence.current += 1;
      validationSequence.current += 1;
      previewSequence.current += 1;
    };
  }, [selectTemplate]);

  useEffect(() => {
    if (
      state.active === null ||
      state.draft === null ||
      state.jsonError !== null ||
      !DashboardManifestSchema.safeParse(state.draft).success
    ) {
      return;
    }
    const requestId = ++validationSequence.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void validateDashboardDraft(
        state.active?.template.templateId ?? "",
        { manifest: state.draft as DashboardManifest, mode: "draft" },
        controller.signal
      )
        .then((validation) => {
          if (
            !controller.signal.aborted &&
            requestId === validationSequence.current
          ) {
            dispatch({ type: "validation-received", validation });
          }
        })
        .catch((error: unknown) => {
          if (
            requestId === validationSequence.current &&
            !(error instanceof DOMException && error.name === "AbortError")
          ) {
            dispatch({ type: "action-failed", message: message(error) });
          }
        });
    }, 300);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      if (requestId === validationSequence.current) {
        validationSequence.current += 1;
      }
    };
  }, [state.active, state.draft, state.jsonError]);

  const runPreview = useCallback(
    async (signal?: AbortSignal) => {
      if (
        state.active === null ||
        state.draft === null ||
        state.jsonError !== null ||
        state.validation?.valid !== true ||
        state.validation.manifestSha256 === null
      ) {
        return;
      }
      const requestId = ++previewSequence.current;
      const templateId = state.active.template.templateId;
      const expectedManifestSha256 = state.validation.manifestSha256;
      dispatch({ type: "preview-loading" });
      try {
        const preview = await previewDashboard(
          templateId,
          {
            manifest: state.draft,
            adapterId: state.draft.runtime.preferredAdapter,
            parameterValues: defaultParameterValues(state.draft),
            filters: state.filters,
            sort: [],
            page: { offset: 0, limit: 100 }
          },
          signal
        );
        if (signal?.aborted || requestId !== previewSequence.current) {
          return;
        }
        if (
          preview.templateId !== templateId ||
          preview.manifestSha256 !== expectedManifestSha256
        ) {
          dispatch({
            type: "preview-failed",
            message: "The preview response did not match the current dashboard draft."
          });
          return;
        }
        dispatch({ type: "preview-received", preview });
      } catch (error) {
        if (requestId !== previewSequence.current) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          dispatch({ type: "preview-cancelled" });
        } else {
          dispatch({ type: "preview-failed", message: message(error) });
        }
      }
    }, [state.active, state.draft, state.filters, state.jsonError, state.validation]);

  useEffect(() => {
    if (
      state.active === null ||
      state.jsonError !== null ||
      state.validation?.valid !== true
    ) {
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void runPreview(controller.signal);
    }, 400);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    runPreview,
    state.active,
    state.jsonError,
    state.validation?.valid
  ]);

  const replaceManifest = useCallback((manifest: DashboardManifest) => {
    validationSequence.current += 1;
    previewSequence.current += 1;
    dispatch({ type: "manifest-edited", manifest });
    const parsed = DashboardManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      dispatch({
        type: "validation-received",
        validation: DashboardValidationResultSchema.parse({
          schemaVersion: "dashboard-validation/v1",
          valid: false,
          publishEligible: false,
          normalizedManifest: null,
          manifestSha256: null,
          diagnostics: parsed.error.issues.slice(0, 100).map((issue) => ({
            severity: "error",
            code: "manifest-schema-invalid",
            path: issue.path
              .map(
                (segment) =>
                  `/${String(segment)
                    .replaceAll("~", "~0")
                    .replaceAll("/", "~1")}`
              )
              .join(""),
            message: issue.message.slice(0, 2_000),
            remediation: "Correct this field before saving the draft."
          }))
        })
      });
    }
  }, []);

  const setJsonText = useCallback((text: string) => {
    validationSequence.current += 1;
    previewSequence.current += 1;
    try {
      const parsed = DashboardManifestSchema.safeParse(JSON.parse(text) as unknown);
      if (!parsed.success) {
        dispatch({
          type: "json-edited",
          text,
          error: parsed.error.issues[0]?.message ?? "The manifest does not match dashboard-template/v1."
        });
        return;
      }
      dispatch({ type: "json-edited", text, manifest: parsed.data });
    } catch {
      dispatch({
        type: "json-edited",
        text,
        error: "The JSON text is incomplete or invalid. Your text is preserved."
      });
    }
  }, []);

  const markBufferedEdit = useCallback(() => {
    validationSequence.current += 1;
    previewSequence.current += 1;
    dispatch({ type: "buffer-edited" });
  }, []);

  const loadAfterMutation = useCallback(
    async (templateId: string, notice: string) => {
      const requestId = ++templateLoadSequence.current;
      validationSequence.current += 1;
      previewSequence.current += 1;
      const [response, revisions, templates] = await Promise.all([
        getDashboardTemplate(templateId),
        listDashboardRevisions(templateId),
        listDashboardTemplates()
      ]);
      if (requestId !== templateLoadSequence.current) {
        return;
      }
      localStorage.setItem(LAST_TEMPLATE_KEY, templateId);
      dispatch({ type: "templates-replaced", templates: templates.items });
      dispatch({ type: "template-loaded", response, revisions: revisions.items });
      dispatch({ type: "action-finished", notice });
    },
    []
  );

  const upsertRawManifest = useCallback(
    async (rawJson: string, sourceLabel: string) => {
      dispatch({ type: "action-started", action: "import" });
      let parsedManifest: DashboardManifest | null = null;
      try {
        parsedManifest = DashboardManifestSchema.parse(JSON.parse(rawJson) as unknown);
      } catch {
        // The server returns the governed validation result for malformed uploads.
      }
      try {
        const imported = await importDashboardManifest(rawJson);
        await loadAfterMutation(
          imported.template.templateId,
          `${sourceLabel} created dashboard ${imported.template.name}.`
        );
      } catch (error) {
        if (
          error instanceof DashboardBuilderApiError &&
          error.code === "revision-conflict" &&
          parsedManifest !== null
        ) {
          try {
            const existing = await getDashboardTemplate(
              parsedManifest.template.templateId
            );
            await updateDashboardDraft(parsedManifest.template.templateId, {
              expectedRevision: existing.template.currentRevision,
              actor: LOCAL_ACTOR,
              manifest: parsedManifest
            });
            await loadAfterMutation(
              parsedManifest.template.templateId,
              `${sourceLabel} replaced the current draft at a checked revision.`
            );
            return;
          } catch (updateError) {
            dispatch({
              type: "action-failed",
              message: message(updateError),
              ...(updateError instanceof DashboardBuilderApiError &&
              updateError.details !== null
                ? { conflictRevision: updateError.details.currentRevision }
                : {})
            });
            return;
          }
        }
        dispatch({ type: "action-failed", message: message(error) });
      }
    },
    [loadAfterMutation]
  );

  const uploadFile = useCallback(
    async (file: File) => {
      if (
        file.size < 1 ||
        file.size > DASHBOARD_MAX_UPLOAD_BYTES ||
        (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json")
      ) {
        dispatch({
          type: "action-failed",
          message: "Choose a non-empty JSON file no larger than 1 MiB."
        });
        return;
      }
      await upsertRawManifest(await file.text(), file.name);
    },
    [upsertRawManifest]
  );

  const startFromSample = useCallback(async () => {
    dispatch({ type: "action-started", action: "sample" });
    try {
      const sample = await downloadDashboardSample();
      await upsertRawManifest(sample.json, "Tracked sample");
    } catch (error) {
      dispatch({ type: "action-failed", message: message(error) });
    }
  }, [upsertRawManifest]);

  const downloadSample = useCallback(async () => {
    dispatch({ type: "action-started", action: "download-sample" });
    try {
      saveDownload(await downloadDashboardSample());
      dispatch({ type: "action-finished", notice: "Sample manifest downloaded." });
    } catch (error) {
      dispatch({ type: "action-failed", message: message(error) });
    }
  }, []);

  const saveDraft = useCallback(async () => {
    if (
      state.active === null ||
      state.draft === null ||
      state.jsonError !== null ||
      state.validation?.valid !== true
    ) {
      return;
    }
    dispatch({ type: "action-started", action: "save" });
    try {
      await updateDashboardDraft(state.active.template.templateId, {
        expectedRevision: state.active.template.currentRevision,
        actor: LOCAL_ACTOR,
        manifest: state.draft
      });
      await loadAfterMutation(state.active.template.templateId, "Draft saved and normalized.");
    } catch (error) {
      dispatch({
        type: "action-failed",
        message: message(error),
        ...(error instanceof DashboardBuilderApiError && error.details !== null
          ? { conflictRevision: error.details.currentRevision }
          : {})
      });
    }
  }, [
    loadAfterMutation,
    state.active,
    state.draft,
    state.jsonError,
    state.validation?.valid
  ]);

  const publish = useCallback(async () => {
    if (
      state.active === null ||
      state.dirty ||
      state.validation?.publishEligible !== true
    ) {
      return;
    }
    dispatch({ type: "action-started", action: "publish" });
    try {
      const response = await publishDashboard(state.active.template.templateId, {
        expectedRevision: state.active.template.currentRevision,
        actor: LOCAL_ACTOR
      });
      await loadAfterMutation(
        state.active.template.templateId,
        response.idempotent
          ? `Revision ${String(response.revision.revisionNumber)} was already current.`
          : `Published immutable revision ${String(response.revision.revisionNumber)}.`
      );
    } catch (error) {
      dispatch({
        type: "action-failed",
        message: message(error),
        ...(error instanceof DashboardBuilderApiError && error.details !== null
          ? { conflictRevision: error.details.currentRevision }
          : {})
      });
    }
  }, [
    loadAfterMutation,
    state.active,
    state.dirty,
    state.validation?.publishEligible
  ]);

  const rollback = useCallback(
    async (revisionNumber: number) => {
      if (state.active === null) {
        return;
      }
      dispatch({ type: "action-started", action: "rollback" });
      try {
        await rollbackDashboard(state.active.template.templateId, {
          expectedRevision: state.active.template.currentRevision,
          targetRevisionNumber: revisionNumber,
          actor: LOCAL_ACTOR
        });
        await loadAfterMutation(
          state.active.template.templateId,
          `Rolled back through new immutable revision from revision ${String(revisionNumber)}.`
        );
      } catch (error) {
        dispatch({
          type: "action-failed",
          message: message(error),
          ...(error instanceof DashboardBuilderApiError && error.details !== null
            ? { conflictRevision: error.details.currentRevision }
            : {})
        });
      }
    },
    [loadAfterMutation, state.active]
  );

  const downloadRevision = useCallback(
    async (revisionNumber: number) => {
      if (state.active === null) {
        return;
      }
      dispatch({ type: "action-started", action: "download-revision" });
      try {
        saveDownload(
          await downloadDashboardRevision(
            state.active.template.templateId,
            revisionNumber
          )
        );
        dispatch({
          type: "action-finished",
          notice: `Revision ${String(revisionNumber)} downloaded.`
        });
      } catch (error) {
        dispatch({ type: "action-failed", message: message(error) });
      }
    },
    [state.active]
  );

  const changeFilter = useCallback(
    (filter: DashboardPreviewRequest["filters"][number] | null) => {
      previewSequence.current += 1;
      if (filter === null) {
        dispatch({ type: "filters-changed", filters: [] });
        return;
      }
      dispatch({
        type: "filters-changed",
        filters: [
          ...state.filters.filter((value) => value.bindingId !== filter.bindingId),
          filter
        ]
      });
    },
    [state.filters]
  );

  const setMode = useCallback((mode: DashboardEditorMode) => {
    dispatch({ type: "mode-changed", mode });
  }, []);

  const refresh = useCallback(async () => {
    dispatch({ type: "action-started", action: "refresh" });
    try {
      await refreshTemplates();
      if (state.active !== null) {
        await selectTemplate(state.active.template.templateId);
      } else {
        dispatch({ type: "action-finished", notice: "Template ledger refreshed." });
      }
    } catch (error) {
      dispatch({ type: "action-failed", message: message(error) });
    }
  }, [refreshTemplates, selectTemplate, state.active]);

  return useMemo(
    () => ({
      state,
      replaceManifest,
      markBufferedEdit,
      setJsonText,
      setMode,
      selectTemplate,
      uploadFile,
      startFromSample,
      downloadSample,
      saveDraft,
      publish,
      rollback,
      downloadRevision,
      changeFilter,
      refresh,
      refreshPreview: () => runPreview()
    }),
    [
      changeFilter,
      downloadRevision,
      downloadSample,
      publish,
      refresh,
      markBufferedEdit,
      replaceManifest,
      rollback,
      runPreview,
      saveDraft,
      selectTemplate,
      setJsonText,
      setMode,
      startFromSample,
      state,
      uploadFile
    ]
  );
}
