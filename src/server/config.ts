// Umgebung (.env) und Tenant-Konfiguration (tenants/<slug>.json). Wird beim Start einmal
// geladen und geprüft; ein Fehler beendet den Prozess mit einer klaren Meldung.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type Bootstrap, ConsentButtonsSchema, PresentationSchema, TextsSchema } from "../shared/api";

const csv = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );

const origin = z.string().refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, "muss ein Origin sein (Schema + Host + optional Port, ohne Pfad und ohne / am Ende)");

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8090),
  WEBCHAT_PUBLIC_ORIGINS: csv.pipe(z.array(origin).min(1)),
  WEBCHAT_RUNTIME_URL: z.url(),
  // none: lokal bzw. Runtime ohne IAM. google-id-token: Runtime auf Cloud Run mit Rolle „Cloud Run Invoker“.
  WEBCHAT_RUNTIME_AUTH: z.enum(["none", "google-id-token"]).default("none"),
  // Audience des ID-Tokens; Standard ist der Origin von WEBCHAT_RUNTIME_URL (die run.app-URL der Runtime).
  WEBCHAT_RUNTIME_AUDIENCE: z.url().optional(),
  WEBCHAT_SIGNING_SECRET: z.string().min(32, "mindestens 32 Zeichen, z. B. openssl rand -base64 32"),
  WEBCHAT_TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).default(0),
  WEBCHAT_DEV_PARENT_ORIGINS: csv.pipe(z.array(origin)),
  WEBCHAT_TENANTS_DIR: z.string().default("tenants"),
  WEBCHAT_WEB_DIR: z.string().default("dist/web"),
});
export type Env = z.infer<typeof EnvSchema>;

const ReasoningEffortName = z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "XHIGH", "MAX"]);

const TenantFileSchema = z.object({
  runtime: z.object({
    tenantId: z.string().min(1).max(128),
    agentId: z.string().min(1).max(128),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }),
  // Modellwerte bewusst ohne Standard: Sie müssen in der Tenant-Datei stehen.
  model: z.object({
    name: z.string().min(1),
    reasoningEffort: ReasoningEffortName,
    maxOutputTokens: z.number().int().min(16),
  }),
  parentOrigins: z.array(origin),
  limits: z.object({
    maxMessageLength: z.number().int().positive(),
    messagesPerMinutePerIp: z.number().int().positive(),
    messagesPerMinutePerConversation: z.number().int().positive(),
    conversationsPerHourPerIp: z.number().int().positive(),
  }),
  presentation: PresentationSchema,
  consentButtons: ConsentButtonsSchema,
  referrerHosts: z.array(z.string()).default([]),
  texts: TextsSchema,
});
type TenantFile = z.infer<typeof TenantFileSchema>;

export type Tenant = TenantFile & {
  slug: string;
  apiKey: string;
  /** Eltern-Origins aus der Tenant-Datei plus die lokalen Dev-Origins. */
  allowedParentOrigins: string[];
};

export type Config = { env: Env; tenants: Map<string, Tenant> };

const SLUG = /^[a-z0-9-]{1,32}$/;

function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsedEnv = EnvSchema.safeParse(source);
  if (!parsedEnv.success) throw new Error(`Ungültige Umgebung:\n${formatIssues(parsedEnv.error)}`);
  const env = parsedEnv.data;
  if (source.NODE_ENV === "production" && env.WEBCHAT_DEV_PARENT_ORIGINS.length > 0) {
    throw new Error("WEBCHAT_DEV_PARENT_ORIGINS ist nur für lokale Tests gedacht und darf mit NODE_ENV=production nicht gesetzt sein.");
  }

  const dir = resolve(env.WEBCHAT_TENANTS_DIR);
  const tenants = new Map<string, Tenant>();
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const slug = file.slice(0, -".json".length);
    if (!SLUG.test(slug)) throw new Error(`tenants/${file}: Slug muss ${SLUG} entsprechen`);
    const parsed = TenantFileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (!parsed.success) throw new Error(`tenants/${file} ist ungültig:\n${formatIssues(parsed.error)}`);
    const apiKey = source[parsed.data.runtime.apiKeyEnv]?.trim();
    if (!apiKey) throw new Error(`tenants/${file}: Umgebungsvariable ${parsed.data.runtime.apiKeyEnv} fehlt`);
    tenants.set(slug, {
      ...parsed.data,
      slug,
      apiKey,
      allowedParentOrigins: [...new Set([...parsed.data.parentOrigins, ...env.WEBCHAT_DEV_PARENT_ORIGINS])],
    });
  }
  if (tenants.size === 0) throw new Error(`Keine Tenant-Konfiguration in ${dir}`);
  return { env, tenants };
}

export function toBootstrap(tenant: Tenant): Bootstrap {
  return {
    tenant: tenant.slug,
    parentOrigins: tenant.allowedParentOrigins,
    maxMessageLength: tenant.limits.maxMessageLength,
    presentation: tenant.presentation,
    consentButtons: tenant.consentButtons,
    referrerHosts: tenant.referrerHosts,
    texts: tenant.texts,
  };
}
