import {
  DashboardAdapterStatusSchema,
  DashboardPreviewResponseSchema,
  type DashboardAdapterStatus,
  type DashboardPreviewRequest,
  type DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";
import { DashboardBuilderError } from "./errors.js";

export interface DashboardDataAdapter {
  readonly adapterId: DashboardAdapterStatus["adapterId"];
  status(): Promise<DashboardAdapterStatus>;
  preview(request: DashboardPreviewRequest): Promise<DashboardPreviewResponse>;
}

export class DashboardAdapterRegistry {
  readonly #adapters: ReadonlyMap<DashboardAdapterStatus["adapterId"], DashboardDataAdapter>;

  constructor(adapters: readonly DashboardDataAdapter[]) {
    const registry = new Map<
      DashboardAdapterStatus["adapterId"],
      DashboardDataAdapter
    >();
    for (const adapter of adapters) {
      if (registry.has(adapter.adapterId)) {
        throw new Error(`dashboard adapter ${adapter.adapterId} is registered twice`);
      }
      registry.set(adapter.adapterId, adapter);
    }
    if (!registry.has("fixture") || !registry.has("qlik")) {
      throw new Error("dashboard adapter registry requires fixture and qlik adapters");
    }
    this.#adapters = registry;
  }

  get(adapterId: DashboardAdapterStatus["adapterId"]): DashboardDataAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (adapter === undefined) {
      throw new DashboardBuilderError(
        "adapter-unavailable",
        "The requested dashboard data adapter is not registered."
      );
    }
    return adapter;
  }

  async listStatuses(): Promise<DashboardAdapterStatus[]> {
    const statuses = await Promise.all(
      [...this.#adapters.values()].map(async (adapter) =>
        DashboardAdapterStatusSchema.parse(await adapter.status())
      )
    );
    return statuses.sort((left, right) => left.adapterId.localeCompare(right.adapterId));
  }

  async preview(request: DashboardPreviewRequest): Promise<DashboardPreviewResponse> {
    const response = await this.get(request.adapterId).preview(request);
    return DashboardPreviewResponseSchema.parse(response);
  }
}
