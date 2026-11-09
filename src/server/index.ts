import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { log } from "./log";
import { createRuntimeClient } from "./runtime/client";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const app = createApp(config, createRuntimeClient(config.env.WEBCHAT_RUNTIME_URL));

const server = serve({ fetch: app.fetch, port: config.env.PORT }, (info) => {
  log.info("listening", { port: info.port, tenants: [...config.tenants.keys()].join(",") });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
