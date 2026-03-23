import { describe, expect, it } from "vitest";
import {
  formatGatewayRuntimeProfileErrorList,
  normalizeGatewayRuntimeProfile,
  resolveGatewayRuntimeProfile,
  shouldStartGatewayChannels,
} from "./runtime-profile.js";

describe("gateway runtime profile", () => {
  it("normalizes supported aliases to canonical profiles", () => {
    expect(normalizeGatewayRuntimeProfile("full")).toBe("full");
    expect(normalizeGatewayRuntimeProfile("minimal")).toBe("minimal-runtime");
    expect(normalizeGatewayRuntimeProfile("minimal-runtime")).toBe("minimal-runtime");
    expect(normalizeGatewayRuntimeProfile("custom-app")).toBe("minimal-runtime");
  });

  it("prefers an explicit profile over the environment", () => {
    expect(
      resolveGatewayRuntimeProfile({
        explicitProfile: "full",
        env: { OPENCLAW_RUNTIME_PROFILE: "custom-app" },
      }),
    ).toBe("full");
  });

  it("falls back to OPENCLAW_RUNTIME_PROFILE and defaults to full", () => {
    expect(resolveGatewayRuntimeProfile({ env: { OPENCLAW_RUNTIME_PROFILE: "custom-app" } })).toBe(
      "minimal-runtime",
    );
    expect(resolveGatewayRuntimeProfile()).toBe("full");
  });

  it("uses the minimal runtime profile to disable automatic channel startup", () => {
    expect(shouldStartGatewayChannels({ profile: "full" })).toBe(true);
    expect(shouldStartGatewayChannels({ profile: "minimal-runtime" })).toBe(false);
  });

  it("renders a helpful validation error list", () => {
    expect(formatGatewayRuntimeProfileErrorList()).toBe(
      '"full", "minimal", "minimal-runtime", or "custom-app"',
    );
  });
});
