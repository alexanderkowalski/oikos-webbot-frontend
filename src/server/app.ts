import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Config, Tenant } from "./config";
import { createApi } from "./routes/api";
import type { RuntimeClient } from "./runtime/client";

/** CSP wie im alten bot-ui (server/middleware/iframe-security.ts): nur frame-ancestors. */
export function frameAncestors(tenant: Tenant) {
  const origins = tenant.allowedParentOrigins;
  return `frame-ancestors ${origins.length > 0 ? origins.join(" ") : "'none'"}`;
}

export function createApp(config: Config, runtime: RuntimeClient) {
  const app = new Hono({ strict: false });
  const webDir = resolve(config.env.WEBCHAT_WEB_DIR);
  const indexPath = join(webDir, "index.html");
  let indexHtml: string | undefined;

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.route("/wc/api", createApi(config, runtime));

  app.use(
    "/wc/assets/*",
    async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
    },
    serveStatic({ root: webDir, rewriteRequestPath: (path) => path.replace(/^\/wc/, "") }),
  );

  app.get("/iframe/:tenant", (c) => {
    const tenant = config.tenants.get(c.req.param("tenant"));
    if (!tenant) return c.text("Not Found", 404);
    if (indexHtml === undefined) {
      if (!existsSync(indexPath)) return c.text("Frontend nicht gebaut (npm run build).", 503);
      indexHtml = readFileSync(indexPath, "utf8");
    }
    c.header("Content-Security-Policy", frameAncestors(tenant));
    c.header("Cache-Control", "no-cache");
    c.header("X-Content-Type-Options", "nosniff");
    return c.html(indexHtml);
  });

  app.notFound((c) => c.text("Not Found", 404));
  return app;
}
