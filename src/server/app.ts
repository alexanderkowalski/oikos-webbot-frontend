import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Config, Tenant } from "./config";
import { createApi } from "./routes/api";
import type { RuntimeClient } from "./runtime/client";

/**
 * CSP der Chatseite. Alles nur vom eigenen Origin; Bilder zusätzlich vom Origin des Avatars.
 * Die strengen Regeln für script-src, img-src und connect-src begrenzen den Schaden, falls eine
 * Modellantwort (z. B. per Prompt-Injection) versucht, Inhalte nachzuladen und so Daten abzuziehen.
 * style-src erlaubt 'unsafe-inline' für die Tenant-Farben, die React als style-Attribut setzt.
 */
export function contentSecurityPolicy(tenant: Tenant) {
  const ancestors = tenant.allowedParentOrigins;
  const avatarOrigin = tenant.presentation.avatarUrl ? new URL(tenant.presentation.avatarUrl).origin : undefined;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self'${avatarOrigin ? ` ${avatarOrigin}` : ""}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors.length > 0 ? ancestors.join(" ") : "'none'"}`,
  ].join("; ");
}

export function createApp(config: Config, runtime: RuntimeClient) {
  const app = new Hono({ strict: false });
  const webDir = resolve(config.env.WEBCHAT_WEB_DIR);
  const indexPath = join(webDir, "index.html");
  let indexHtml: string | undefined;

  // Nicht /healthz: Auf *.run.app fängt das Google Frontend Pfade wie /healthz ab, bevor sie den Container erreichen.
  app.get("/health", (c) => c.json({ status: "ok" }));

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
    c.header("Content-Security-Policy", contentSecurityPolicy(tenant));
    c.header("Cache-Control", "no-cache");
    c.header("X-Content-Type-Options", "nosniff");
    return c.html(indexHtml);
  });

  app.notFound((c) => c.text("Not Found", 404));
  return app;
}
