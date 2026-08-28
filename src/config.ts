export interface Config {
  port: number;
  dbPath: string;
  tokens: string[];
  devMode: boolean;
  /** Milliseconds between SSE heartbeat comments on GET /events. */
  heartbeatMs: number;
  /** Reads WEBHOOK_SECRET_<PROVIDER uppercased>, e.g. secretFor("github") -> WEBHOOK_SECRET_GITHUB. */
  secretFor(provider: string): string | undefined;
}

const DEFAULT_HEARTBEAT_MS = 15000;

/** Reads all catamorbius config from env (defaults to process.env). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT ?? "3000");
  const dbPath = env.CATAMORBIUS_DB ?? "./data/catamorbius.sqlite";
  const tokens = (env.CATAMORBIUS_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const devMode = env.CATAMORBIUS_DEV_MODE === "1";
  const parsedHeartbeatMs = Number(env.CATAMORBIUS_HEARTBEAT_MS);
  const heartbeatMs = Number.isFinite(parsedHeartbeatMs) && parsedHeartbeatMs > 0 ? parsedHeartbeatMs : DEFAULT_HEARTBEAT_MS;

  return {
    port,
    dbPath,
    tokens,
    devMode,
    heartbeatMs,
    secretFor: (provider: string) => env[`WEBHOOK_SECRET_${provider.toUpperCase()}`],
  };
}
