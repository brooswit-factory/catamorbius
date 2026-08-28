import type { ProviderAdapter } from "./types.js";
import { github } from "./github.js";

export type { ProviderAdapter, VerifyResult, VerifyOk, VerifyFail } from "./types.js";

/** The provider registry. Adding a provider = one new file + one entry here. */
export const adapters: ProviderAdapter[] = [github];
