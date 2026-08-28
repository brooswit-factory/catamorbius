import type { CloudEvent } from "../events/types.js";

export interface VerifyOk { ok: true }
export interface VerifyFail { ok: false; reason: string }
export type VerifyResult = VerifyOk | VerifyFail;

/**
 * One provider adapter. `provider` is mounted at POST /webhooks/<provider>;
 * its secret is read from env WEBHOOK_SECRET_<PROVIDER uppercased>.
 *
 * `toEvents` is expected to handle payloads it doesn't recognize itself
 * (emitting one <provider>.unknown event with best-effort id/source and raw
 * intact). If it throws instead, the generic ingress layer wraps the
 * delivery as <provider>.unknown on its behalf.
 */
export interface ProviderAdapter {
  provider: string;
  verify(headers: Record<string, string>, rawBody: string | Uint8Array, secret: string): VerifyResult;
  toEvents(rawBody: string | Uint8Array, headers: Record<string, string>): CloudEvent[];
}
