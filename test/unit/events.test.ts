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
});
