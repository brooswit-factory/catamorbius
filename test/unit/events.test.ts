import { describe, expect, test } from "bun:test";
import { createCloudEvent, isCloudEvent } from "../../src/events/index.js";

describe("events", () => {
  test("minimal envelope gets empty summary and no subject", () => {
    const e = createCloudEvent({
      id: "1",
      source: "//github/brooswit-factory",
      type: "com.github.pull_request.opened",
      time: "2026-08-28T00:00:00Z",
      raw: { body: { a: 1 }, headers: {} },
    });
    expect(e.specversion).toBe("1.0");
    expect(e.datacontenttype).toBe("application/json");
    expect(e.data.summary).toEqual({});
    expect("subject" in e).toBe(false);
    expect(isCloudEvent(e)).toBe(true);
  });

  test("includes subject and summary when given", () => {
    const e = createCloudEvent({
      id: "1",
      source: "//jira/wroosbit.atlassian.net",
      type: "com.atlassian.jira.issue.updated",
      time: "2026-08-28T00:00:00Z",
      subject: "KAN-123",
      raw: { body: {}, headers: {} },
      summary: { actor: "bob", action: "updated" },
    });
    expect(e.subject).toBe("KAN-123");
    expect(e.data.summary).toEqual({ actor: "bob", action: "updated" });
  });

  test("throws when id is empty", () => {
    expect(() =>
      createCloudEvent({ id: "", source: "//x/y", type: "x.y", time: "t", raw: { body: {}, headers: {} } }),
    ).toThrow();
  });

  test("throws when source is empty", () => {
    expect(() =>
      createCloudEvent({ id: "1", source: "", type: "x.y", time: "t", raw: { body: {}, headers: {} } }),
    ).toThrow();
  });

  test("throws when type is empty", () => {
    expect(() =>
      createCloudEvent({ id: "1", source: "//x/y", type: "", time: "t", raw: { body: {}, headers: {} } }),
    ).toThrow();
  });

  test("throws when time is empty", () => {
    expect(() =>
      createCloudEvent({ id: "1", source: "//x/y", type: "x.y", time: "", raw: { body: {}, headers: {} } }),
    ).toThrow();
  });

  test("isCloudEvent rejects non-envelopes", () => {
    expect(isCloudEvent(null)).toBe(false);
    expect(isCloudEvent({})).toBe(false);
    expect(isCloudEvent({ specversion: "1.0" })).toBe(false);
    expect(isCloudEvent({ specversion: "1.0", id: "1", source: "s", type: "t", time: "x", datacontenttype: "application/json", data: {}, subject: 5 })).toBe(false);
  });

  function topLevelValid(data: unknown) {
    return { specversion: "1.0", id: "1", source: "//x/y", type: "x.y", time: "t", datacontenttype: "application/json", data };
  }

  test("isCloudEvent rejects a top-level-valid envelope with a broken data", () => {
    expect(isCloudEvent(topLevelValid({}))).toBe(false);
    expect(isCloudEvent(topLevelValid({ raw: {}, summary: {} }))).toBe(false);
    expect(isCloudEvent(topLevelValid({ raw: { headers: {} }, summary: {} }))).toBe(false);
    expect(isCloudEvent(topLevelValid({ raw: { body: {}, headers: { a: 1 } }, summary: {} }))).toBe(false);
    expect(isCloudEvent(topLevelValid({ raw: { body: {}, headers: {} }, summary: null }))).toBe(false);
  });

  test("isCloudEvent accepts data.raw.body of null/0/\"\" as long as the key is present", () => {
    expect(isCloudEvent(topLevelValid({ raw: { body: null, headers: {} }, summary: {} }))).toBe(true);
    expect(isCloudEvent(topLevelValid({ raw: { body: 0, headers: {} }, summary: {} }))).toBe(true);
    expect(isCloudEvent(topLevelValid({ raw: { body: "", headers: {} }, summary: {} }))).toBe(true);
  });

  test("isCloudEvent accepts a fully conforming envelope", () => {
    expect(isCloudEvent(topLevelValid({ raw: { body: { a: 1 }, headers: { "x-a": "1" } }, summary: {} }))).toBe(true);
  });
});
