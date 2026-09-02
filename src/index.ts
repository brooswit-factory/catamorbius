import { buildApp } from "./server.js";

export { buildApp } from "./server.js";

export function start(port = Number(process.env.PORT ?? 3000), host = process.env.HOST) {
  return buildApp().listen(host ? { port, hostname: host } : port);
}

if (import.meta.main) start();
