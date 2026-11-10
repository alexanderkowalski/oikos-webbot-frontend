import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { type Config, loadConfig } from "./config";
import { log } from "./log";
import { createRuntimeClient } from "./runtime/client";
import { createIdTokenSource } from "./runtime/id-token";

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const { env } = config;
const audience = env.WEBCHAT_RUNTIME_AUDIENCE ?? new URL(env.WEBCHAT_RUNTIME_URL).origin;
const runtime = createRuntimeClient(env.WEBCHAT_RUNTIME_URL, {
  idToken: env.WEBCHAT_RUNTIME_AUTH === "google-id-token" ? createIdTokenSource(audience) : undefined,
});
const app = createApp(config, runtime);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info("listening", {
    port: info.port,
    tenants: [...config.tenants.keys()].join(","),
    runtimeAuth: env.WEBCHAT_RUNTIME_AUTH,
    runtimeAudience: env.WEBCHAT_RUNTIME_AUTH === "google-id-token" ? audience : undefined,
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
