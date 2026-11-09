import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";

const base = {
  WEBCHAT_PUBLIC_ORIGINS: "http://chat.test",
  WEBCHAT_RUNTIME_URL: "http://runtime.test",
  WEBCHAT_SIGNING_SECRET: "s".repeat(32),
  WEBCHAT_RUNTIME_API_KEY_HH: "key-hh",
};

describe("loadConfig", () => {
  it("lehnt WEBCHAT_DEV_PARENT_ORIGINS in Produktion ab", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", WEBCHAT_DEV_PARENT_ORIGINS: "http://localhost:5174" })).toThrow(
      /WEBCHAT_DEV_PARENT_ORIGINS/,
    );
  });
  it("startet in Produktion ohne Dev-Origins und lokal mit ihnen", () => {
    expect(loadConfig({ ...base, NODE_ENV: "production" }).tenants.get("hh")?.allowedParentOrigins).toEqual(["https://www.hanse-haus.de"]);
    expect(loadConfig({ ...base, WEBCHAT_DEV_PARENT_ORIGINS: "http://localhost:5174" }).tenants.get("hh")?.allowedParentOrigins).toEqual([
      "https://www.hanse-haus.de",
      "http://localhost:5174",
    ]);
  });
});
