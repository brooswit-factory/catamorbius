import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config.js";

describe("config", () => {
  test("defaults with no env set", () => {
    const c = loadConfig({});
    expect(c.port).toBe(3000);
    expect(c.host).toBeUndefined();
    expect(c.dbPath).toBe("./data/catamorbius.sqlite");
    expect(c.tokens).toEqual([]);
    expect(c.devMode).toBe(false);
    expect(c.heartbeatMs).toBe(15000);
    expect(c.secretFor("github")).toBeUndefined();
  });

  test("reads overrides from env", () => {
    const c = loadConfig({
      PORT: "4000",
      HOST: "127.0.0.1",
      CATAMORBIUS_DB: ":memory:",
      CATAMORBIUS_TOKENS: "a, b ,c",
      CATAMORBIUS_DEV_MODE: "1",
    });
    expect(c.port).toBe(4000);
    expect(c.host).toBe("127.0.0.1");
    expect(c.dbPath).toBe(":memory:");
    expect(c.tokens).toEqual(["a", "b", "c"]);
    expect(c.devMode).toBe(true);
  });

  test("secretFor reads WEBHOOK_SECRET_<PROVIDER uppercased>", () => {
    const c = loadConfig({ WEBHOOK_SECRET_GITHUB: "shh" });
    expect(c.secretFor("github")).toBe("shh");
    expect(c.secretFor("jira")).toBeUndefined();
  });

  test("dev mode is only enabled by the exact string '1'", () => {
    expect(loadConfig({ CATAMORBIUS_DEV_MODE: "true" }).devMode).toBe(false);
    expect(loadConfig({ CATAMORBIUS_DEV_MODE: "0" }).devMode).toBe(false);
  });

  test("blank token list yields an empty array, not [\"\"]", () => {
    expect(loadConfig({ CATAMORBIUS_TOKENS: "" }).tokens).toEqual([]);
  });

  test("heartbeatMs reads CATAMORBIUS_HEARTBEAT_MS", () => {
    expect(loadConfig({ CATAMORBIUS_HEARTBEAT_MS: "100" }).heartbeatMs).toBe(100);
  });

  test("heartbeatMs falls back to the default when unset", () => {
    expect(loadConfig({}).heartbeatMs).toBe(15000);
  });

  test("heartbeatMs falls back to the default on a non-numeric or non-positive value", () => {
    expect(loadConfig({ CATAMORBIUS_HEARTBEAT_MS: "not-a-number" }).heartbeatMs).toBe(15000);
    expect(loadConfig({ CATAMORBIUS_HEARTBEAT_MS: "-5" }).heartbeatMs).toBe(15000);
    expect(loadConfig({ CATAMORBIUS_HEARTBEAT_MS: "0" }).heartbeatMs).toBe(15000);
  });
});
