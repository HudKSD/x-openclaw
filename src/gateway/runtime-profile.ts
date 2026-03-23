export const GATEWAY_RUNTIME_PROFILES = ["full", "minimal-runtime"] as const;

export type GatewayRuntimeProfile = (typeof GATEWAY_RUNTIME_PROFILES)[number];

const GATEWAY_RUNTIME_PROFILE_ALIASES = {
  full: "full",
  minimal: "minimal-runtime",
  "minimal-runtime": "minimal-runtime",
  "custom-app": "minimal-runtime",
} as const satisfies Record<string, GatewayRuntimeProfile>;

export function normalizeGatewayRuntimeProfile(raw: unknown): GatewayRuntimeProfile | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return GATEWAY_RUNTIME_PROFILE_ALIASES[normalized] ?? null;
}

export function formatGatewayRuntimeProfileChoices(): string {
  return Object.keys(GATEWAY_RUNTIME_PROFILE_ALIASES)
    .map((choice) => `"${choice}"`)
    .join("|");
}

export function formatGatewayRuntimeProfileErrorList(): string {
  const quoted = Object.keys(GATEWAY_RUNTIME_PROFILE_ALIASES).map((choice) => `"${choice}"`);
  if (quoted.length <= 1) {
    return quoted[0] ?? "";
  }
  if (quoted.length === 2) {
    return `${quoted[0]} or ${quoted[1]}`;
  }
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

export function resolveGatewayRuntimeProfile(params?: {
  explicitProfile?: unknown;
  env?: NodeJS.ProcessEnv;
}): GatewayRuntimeProfile {
  return (
    normalizeGatewayRuntimeProfile(params?.explicitProfile) ??
    normalizeGatewayRuntimeProfile(params?.env?.OPENCLAW_RUNTIME_PROFILE) ??
    "full"
  );
}

export function shouldStartGatewayChannels(params?: { profile?: GatewayRuntimeProfile }): boolean {
  return (params?.profile ?? "full") !== "minimal-runtime";
}
