import { createCloudEvent } from "../../src/events/index.js";
import type { CloudEvent } from "../../src/events/types.js";
import type { ProviderAdapter, VerifyResult } from "../../src/adapters/types.js";

export interface FakeAdapterOptions {
  provider?: string;
  verifyResult?: VerifyResult;
  toEvents?: (rawBody: string | Uint8Array, headers: Record<string, string>) => CloudEvent[];
}

/** A test-only ProviderAdapter used to drive the generic ingress layer end to end. */
export function createFakeAdapter(options: FakeAdapterOptions = {}): ProviderAdapter {
  const provider = options.provider ?? "fake";

  return {
    provider,
    verify(_headers, _rawBody, _secret) {
      return options.verifyResult ?? { ok: true };
    },
    toEvents(rawBody, headers) {
      if (options.toEvents) return options.toEvents(rawBody, headers);
      const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
      const body = JSON.parse(text);
      return [
        createCloudEvent({
          id: typeof body?.id === "string" ? body.id : text,
          source: `//${provider}/test`,
          type: `${provider}.event`,
          time: new Date().toISOString(),
          raw: { body, headers },
        }),
      ];
    },
  };
}
