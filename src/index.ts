import { buildApp } from "./server.js";

export { buildApp } from "./server.js";

export function start(port = Number(process.env.PORT ?? 3000)) {
  return buildApp().listen(port);
}

if (import.meta.main) start();
