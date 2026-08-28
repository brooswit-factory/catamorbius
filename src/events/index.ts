import type { CloudEvent, CloudEventRaw, CloudEventSummary } from "./types.js";

export * from "./types.js";

export interface CreateCloudEventInput {
  id: string;
  source: string;
  type: string;
  time: string;
  subject?: string;
  raw: CloudEventRaw;
  summary?: CloudEventSummary;
}

/** Builds a spec-conformant envelope. Throws if a required field is empty. */
export function createCloudEvent(input: CreateCloudEventInput): CloudEvent {
  if (!input.id) throw new Error("CloudEvent requires a non-empty id");
  if (!input.source) throw new Error("CloudEvent requires a non-empty source");
  if (!input.type) throw new Error("CloudEvent requires a non-empty type");
  if (!input.time) throw new Error("CloudEvent requires a non-empty time");

  return {
    specversion: "1.0",
    id: input.id,
    source: input.source,
    type: input.type,
    time: input.time,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    datacontenttype: "application/json",
    data: {
      raw: input.raw,
      summary: input.summary ?? {},
    },
  };
}

/** Structural check that `x` has the required top-level CloudEvents attributes. */
export function isCloudEvent(x: unknown): x is CloudEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    e.specversion === "1.0" &&
    typeof e.id === "string" && e.id.length > 0 &&
    typeof e.source === "string" && e.source.length > 0 &&
    typeof e.type === "string" && e.type.length > 0 &&
    typeof e.time === "string" && e.time.length > 0 &&
    (e.subject === undefined || typeof e.subject === "string") &&
    e.datacontenttype === "application/json" &&
    typeof e.data === "object" && e.data !== null
  );
}
