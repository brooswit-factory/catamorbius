import { Elysia } from "elysia";
import { loadConfig, type Config } from "./config.js";
import { open, type Store } from "./store/index.js";
import { adapters as defaultAdapters } from "./adapters/index.js";
import type { ProviderAdapter } from "./adapters/types.js";
import { buildIngress } from "./ingress/index.js";

export interface BuildAppOptions {
  config?: Config;
  store?: Store;
  adapters?: ProviderAdapter[];
}

/** Wires config + store + the adapter registry into the Elysia app. */
export function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const store = options.store ?? open(config.dbPath);
  const adapters = options.adapters ?? defaultAdapters;
  const ingress = buildIngress({ config, store, adapters });

  return new Elysia()
    .use(ingress)
    .get("/healthz", () => ({ ok: true, seq: store.latestSeq() }));
}
