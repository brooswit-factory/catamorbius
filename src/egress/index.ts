import { Elysia } from "elysia";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { Store, StoredEvent } from "../store/index.js";

export interface EgressDeps {
  config: Config;
  store: Store;
}

interface Filters {
  type?: string;
  source?: string;
  subject?: string;
}

const CURSOR_RE = /^\d+$/;
const BACKFILL_PAGE_SIZE = 500;
const encoder = new TextEncoder();

function hashToken(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Constant-time membership check. Hashing first fixes both operands to the
 * same length so timingSafeEqual never rejects on a length mismatch (which
 * would leak the candidate's length relative to a token's), and every
 * configured token is compared with no early exit so timing doesn't reveal
 * which token (if any) matched.
 */
function isKnownToken(tokens: string[], candidate: string): boolean {
  const candidateHash = hashToken(candidate);
  let matched = false;
  for (const token of tokens) {
    if (timingSafeEqual(hashToken(token), candidateHash)) matched = true;
  }
  return matched;
}

function matchesFilters(row: StoredEvent, filters: Filters): boolean {
  if (filters.type !== undefined && !row.event.type.startsWith(filters.type)) return false;
  if (filters.source !== undefined && row.event.source !== filters.source) return false;
  if (filters.subject !== undefined && row.event.subject !== filters.subject) return false;
  return true;
}

function frameBytes(row: StoredEvent): Uint8Array {
  return encoder.encode(`event: ${row.event.type}\nid: ${row.seq}\ndata: ${JSON.stringify(row.event)}\n\n`);
}

function jsonResponse(status: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** GET /events — SSE stream of stored CloudEvents with filters, cursor resume, and heartbeats. */
export function buildEgress({ config, store }: EgressDeps) {
  return new Elysia().get("/events", ({ request }) => {
    const url = new URL(request.url);

    if (config.tokens.length === 0) {
      if (!config.devMode) {
        console.error("[catamorbius] refusing GET /events: CATAMORBIUS_TOKENS is not set");
        return jsonResponse(503, { error: "no bearer tokens configured" });
      }
      console.warn("[catamorbius] WARN dev mode: CATAMORBIUS_TOKENS is not set — GET /events is open, unauthenticated");
    } else {
      const authHeader = request.headers.get("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (token === null || !isKnownToken(config.tokens, token)) {
        return jsonResponse(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      }
    }

    const filters: Filters = {};
    const typeParam = url.searchParams.get("type");
    const sourceParam = url.searchParams.get("source");
    const subjectParam = url.searchParams.get("subject");
    if (typeParam !== null) filters.type = typeParam;
    if (sourceParam !== null) filters.source = sourceParam;
    if (subjectParam !== null) filters.subject = subjectParam;

    // Cursor precedence: Last-Event-ID (the reconnect case) wins over ?from
    // whenever both are present; ?from is not even consulted in that case.
    let backfillFrom: number | null = null;
    const lastEventId = request.headers.get("last-event-id");
    if (lastEventId !== null) {
      if (!CURSOR_RE.test(lastEventId)) return jsonResponse(400, { error: "invalid Last-Event-ID" });
      backfillFrom = Number(lastEventId) + 1;
    } else {
      const fromParam = url.searchParams.get("from");
      if (fromParam !== null) {
        if (fromParam === "earliest") {
          backfillFrom = 1;
        } else if (CURSOR_RE.test(fromParam)) {
          backfillFrom = Number(fromParam);
        } else {
          return jsonResponse(400, { error: "invalid ?from cursor" });
        }
      }
    }

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      unsubscribe?.();
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("retry: 3000\n\n"));

        let lastEmittedSeq = 0;
        let live = false;
        const buffered: StoredEvent[] = [];

        unsubscribe = store.subscribe((row) => {
          if (!live) {
            buffered.push(row);
            return;
          }
          if (row.seq > lastEmittedSeq && matchesFilters(row, filters)) {
            controller.enqueue(frameBytes(row));
            lastEmittedSeq = row.seq;
          }
        });

        if (backfillFrom !== null) {
          let from = backfillFrom;
          for (;;) {
            const page = store.read({ from, limit: BACKFILL_PAGE_SIZE, ...filters });
            for (const row of page) {
              controller.enqueue(frameBytes(row));
              lastEmittedSeq = row.seq;
            }
            if (page.length < BACKFILL_PAGE_SIZE) break;
            from = lastEmittedSeq + 1;
          }
        }

        for (const row of buffered) {
          if (row.seq > lastEmittedSeq && matchesFilters(row, filters)) {
            controller.enqueue(frameBytes(row));
            lastEmittedSeq = row.seq;
          }
        }
        buffered.length = 0;
        live = true;

        heartbeatTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            cleanup();
          }
        }, config.heartbeatMs);
      },
      cancel() {
        cleanup();
      },
    });

    request.signal.addEventListener("abort", cleanup);

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}
