import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CloudEvent } from "../events/types.js";

export interface StoredEvent { seq: number; event: CloudEvent }
export interface AppendResult { seq: number; duplicate: boolean }
export interface ReadQuery { from?: number; limit?: number; type?: string; source?: string; subject?: string }
export type Unsubscribe = () => void;

export interface Store {
  append(event: CloudEvent): AppendResult;
  read(query?: ReadQuery): StoredEvent[];
  latestSeq(): number;
  subscribe(fn: (row: StoredEvent) => void): Unsubscribe;
  close(): void;
}

interface EventRow {
  seq: number;
  id: string;
  source: string;
  type: string;
  subject: string | null;
  time: string;
  headers: string;
  raw: string;
  summary: string;
}

function rowToEvent(row: EventRow): CloudEvent {
  return {
    specversion: "1.0",
    id: row.id,
    source: row.source,
    type: row.type,
    time: row.time,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    datacontenttype: "application/json",
    data: {
      raw: { body: JSON.parse(row.raw), headers: JSON.parse(row.headers) },
      summary: JSON.parse(row.summary),
    },
  };
}

/** Opens (creating if needed) the append-only sqlite event log. `path` may be ":memory:". */
export function open(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      subject TEXT,
      time TEXT NOT NULL,
      headers TEXT NOT NULL,
      raw TEXT NOT NULL,
      summary TEXT NOT NULL,
      UNIQUE(source, id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS events_type_idx ON events(type)");
  db.exec("CREATE INDEX IF NOT EXISTS events_source_idx ON events(source)");
  db.exec("CREATE INDEX IF NOT EXISTS events_subject_idx ON events(subject)");

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO events (id, source, type, subject, time, headers, raw, summary)
     VALUES ($id, $source, $type, $subject, $time, $headers, $raw, $summary)`,
  );
  const findSeqStmt = db.prepare(`SELECT seq FROM events WHERE source = $source AND id = $id`);
  const maxSeqStmt = db.prepare(`SELECT MAX(seq) as seq FROM events`);

  const subscribers = new Set<(row: StoredEvent) => void>();

  return {
    append(event) {
      const result = insertStmt.run({
        $id: event.id,
        $source: event.source,
        $type: event.type,
        $subject: event.subject ?? null,
        $time: event.time,
        $headers: JSON.stringify(event.data.raw.headers),
        $raw: JSON.stringify(event.data.raw.body),
        $summary: JSON.stringify(event.data.summary),
      });
      if (result.changes === 0) {
        const existing = findSeqStmt.get({ $source: event.source, $id: event.id }) as { seq: number };
        return { seq: existing.seq, duplicate: true };
      }
      const seq = Number(result.lastInsertRowid);
      const stored: StoredEvent = { seq, event };
      for (const fn of subscribers) fn(stored);
      return { seq, duplicate: false };
    },
    read(query = {}) {
      const clauses = ["seq >= $from"];
      const params: Record<string, string | number> = { $from: query.from ?? 0 };
      if (query.type !== undefined) { clauses.push("substr(type, 1, length($type)) = $type"); params.$type = query.type; }
      if (query.source !== undefined) { clauses.push("source = $source"); params.$source = query.source; }
      if (query.subject !== undefined) { clauses.push("subject = $subject"); params.$subject = query.subject; }
      let sql = `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC`;
      if (query.limit !== undefined) { sql += " LIMIT $limit"; params.$limit = query.limit; }
      const rows = db.query(sql).all(params) as EventRow[];
      return rows.map((row) => ({ seq: row.seq, event: rowToEvent(row) }));
    },
    latestSeq() {
      const row = maxSeqStmt.get() as { seq: number | null };
      return row.seq ?? 0;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    close() { db.close(); },
  };
}
