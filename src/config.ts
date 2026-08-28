export interface Config {
  port: number;
  dbPath: string;
  tokens: string[];
  devMode: boolean;
  /** Reads WEBHOOK_SECRET_<PROVIDER uppercased>, e.g. secretFor("github") -> WEBHOOK_SECRET_GITHUB. */
  secretFor(provider: string): string | undefined;
}

/** Reads all catamorbius config from env (defaults to process.env). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT ?? "3000");
  const dbPath = env.CATAMORBIUS_DB ?? "./data/catamorbius.sqlite";
  const tokens = (env.CATAMORBIUS_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const devMode = env.CATAMORBIUS_DEV_MODE === "1";

  return {
    port,
    dbPath,
    tokens,
    devMode,
    secretFor: (provider: string) => env[`WEBHOOK_SECRET_${provider.toUpperCase()}`],
  };
}
