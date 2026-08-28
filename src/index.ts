import { Elysia } from "elysia";

export const app = new Elysia().get("/healthz", () => ({ ok: true }));

export function start(port = Number(process.env.PORT ?? 3000)) {
  return app.listen(port);
}

if (import.meta.main) start();

