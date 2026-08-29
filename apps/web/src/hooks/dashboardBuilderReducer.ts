import type {
  DashboardAdapterStatus,
  DashboardManifest,
  DashboardPreviewRequest,
  DashboardPreviewResponse,
  DashboardRevisionSummary,
  DashboardTemplateResponse,
  DashboardTemplateSummary,
  DashboardValidationResult
} from "@unified-ai/contracts/dashboard-builder";

export type DashboardEditorMode = "form" | "json";

export interface DashboardBuilderState {
  templates: DashboardTemplateSummary[];
  adapters: DashboardAdapterStatus[];
  active: DashboardTemplateResponse | null;
  draft: DashboardManifest | null;
  jsonText: string;
  jsonError: string | null;
  validation: DashboardValidationResult | null;
  preview: DashboardPreviewResponse | null;
  revisions: DashboardRevisionSummary[];
  filters: DashboardPreviewRequest["filters"];
  mode: DashboardEditorMode;
  dirty: boolean;
  loading: boolean;
  previewLoading: boolean;
  pendingAction: string | null;
  error: string | null;
  notice: string | null;
  conflictRevision: number | null;
}

export const initialDashboardBuilderState: DashboardBuilderState = {
  templates: [],
  adapters: [],
  active: null,
  draft: null,
  jsonText: "",
  jsonError: null,
  validation: null,
  preview: null,
  revisions: [],
  filters: [],
  mode: "form",
  dirty: false,
  loading: true,
  previewLoading: false,
  pendingAction: null,
  error: null,
  notice: null,
  conflictRevision: null
};

export type DashboardBuilderAction =
  | {
      type: "workspace-loaded";
      templates: DashboardTemplateSummary[];
      adapters: DashboardAdapterStatus[];
    }
  | { type: "workspace-failed"; message: string }
  | { type: "template-loading" }
  | {
      type: "template-loaded";
      response: DashboardTemplateResponse;
      revisions: DashboardRevisionSummary[];
    }
  | { type: "manifest-edited"; manifest: DashboardManifest }
  | { type: "buffer-edited" }
  | { type: "json-edited"; text: string; manifest?: DashboardManifest; error?: string }
  | { type: "validation-received"; validation: DashboardValidationResult }
  | { type: "preview-loading" }
  | { type: "preview-received"; preview: DashboardPreviewResponse }
  | { type: "preview-cancelled" }
  | { type: "preview-failed"; message: string }
  | { type: "filters-changed"; filters: DashboardPreviewRequest["filters"] }
  | { type: "mode-changed"; mode: DashboardEditorMode }
  | { type: "action-started"; action: string }
  | { type: "action-finished"; notice: string }
  | { type: "action-failed"; message: string; conflictRevision?: number }
  | { type: "templates-replaced"; templates: DashboardTemplateSummary[] }
  | { type: "notice-cleared" };

function manifestJson(manifest: DashboardManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function dashboardBuilderReducer(
  state: DashboardBuilderState,
  action: DashboardBuilderAction
): DashboardBuilderState {
  switch (action.type) {
    case "workspace-loaded":
      return {
        ...state,
        templates: action.templates,
        adapters: action.adapters,
        loading: false,
        error: null
      };
    case "workspace-failed":
      return {
        ...state,
        loading: false,
        previewLoading: false,
        pendingAction: null,
        error: action.message
      };
    case "template-loading":
      return {
        ...state,
        loading: true,
        previewLoading: false,
        error: null,
        notice: null
      };
    case "template-loaded":
      return {
        ...state,
        active: action.response,
        draft: action.response.manifest,
        jsonText: manifestJson(action.response.manifest),
        jsonError: null,
        validation: action.response.validation,
        preview: null,
        revisions: action.revisions,
        filters: [],
        dirty: false,
        loading: false,
        previewLoading: false,
        pendingAction: null,
        error: null,
        conflictRevision: null
      };
    case "manifest-edited":
      return {
        ...state,
        draft: action.manifest,
        jsonText: manifestJson(action.manifest),
        jsonError: null,
        validation: null,
        preview: null,
        previewLoading: false,
        dirty: true,
        notice: null,
        conflictRevision: null
      };
    case "buffer-edited":
      return {
        ...state,
        validation: null,
        preview: null,
        previewLoading: false,
        dirty: true,
        notice: null,
        conflictRevision: null
      };
    case "json-edited":
      return {
        ...state,
        jsonText: action.text,
        ...(action.manifest === undefined ? {} : { draft: action.manifest }),
        jsonError: action.error ?? null,
        validation: null,
        preview: null,
        previewLoading: false,
        dirty: true,
        notice: null,
        conflictRevision: null
      };
    case "validation-received":
      return { ...state, validation: action.validation };
    case "preview-loading":
      return { ...state, previewLoading: true, error: null };
    case "preview-received":
      return { ...state, preview: action.preview, previewLoading: false, error: null };
    case "preview-cancelled":
      return { ...state, previewLoading: false };
    case "preview-failed":
      return {
        ...state,
        preview: null,
        previewLoading: false,
        error: action.message
      };
    case "filters-changed":
      return {
        ...state,
        filters: action.filters,
        preview: null,
        previewLoading: false
      };
    case "mode-changed":
      return { ...state, mode: action.mode };
    case "action-started":
      return {
        ...state,
        pendingAction: action.action,
        error: null,
        notice: null,
        conflictRevision: null
      };
    case "action-finished":
      return { ...state, pendingAction: null, notice: action.notice, error: null };
    case "action-failed":
      return {
        ...state,
        pendingAction: null,
        error: action.message,
        conflictRevision: action.conflictRevision ?? null
      };
    case "templates-replaced":
      return { ...state, templates: action.templates };
    case "notice-cleared":
      return { ...state, notice: null, error: null };
  }
}
