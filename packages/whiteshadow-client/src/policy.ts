import {
  WhiteShadowCapabilitySchema,
  type WhiteShadowCapability
} from "@unified-ai/contracts";

export const WHITESHADOW_SAFE_CAPABILITIES = [
  {
    capabilityId: "health",
    name: "Health",
    description: "Read the localhost WhiteShadow web service health summary.",
    risk: "safe",
    modelUse: "none",
    mode: "read",
    path: "/api/health"
  },
  {
    capabilityId: "runtime-summary",
    name: "Runtime summary",
    description: "Read a redacted WhiteShadow runtime summary without inference.",
    risk: "safe",
    modelUse: "none",
    mode: "read",
    path: "/api/runtime"
  },
  {
    capabilityId: "capability-catalog",
    name: "Capability catalog",
    description: "Read capability catalog counts and generation metadata.",
    risk: "safe",
    modelUse: "none",
    mode: "read",
    path: "/api/capabilities/catalog"
  },
  {
    capabilityId: "skills-catalog",
    name: "Skills catalog",
    description: "Read WhiteShadow skill catalog counts without running a skill.",
    risk: "safe",
    modelUse: "none",
    mode: "read",
    path: "/api/skills/catalog"
  },
  {
    capabilityId: "plugins-catalog",
    name: "Plugins catalog",
    description: "Read WhiteShadow plugin catalog counts without invoking a plugin.",
    risk: "safe",
    modelUse: "none",
    mode: "read",
    path: "/api/plugins/catalog"
  }
] as const;

export type WhiteShadowSafeCapabilityId =
  (typeof WHITESHADOW_SAFE_CAPABILITIES)[number]["capabilityId"];

export function listSafeCapabilities(): WhiteShadowCapability[] {
  return WHITESHADOW_SAFE_CAPABILITIES.map(({ path: _path, ...capability }) =>
    WhiteShadowCapabilitySchema.parse(capability)
  );
}

export function resolveSafeCapability(capabilityId: string):
  | (typeof WHITESHADOW_SAFE_CAPABILITIES)[number]
  | undefined {
  return WHITESHADOW_SAFE_CAPABILITIES.find(
    (capability) => capability.capabilityId === capabilityId
  );
}
