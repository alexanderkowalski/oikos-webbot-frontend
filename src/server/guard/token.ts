// Conversation-Token: Der Browser bekommt nie die rohe Gesprächs-ID, sondern
// v1.<payload>.<signatur>, payload = base64url(JSON {t: Tenant-Slug, c: Gesprächs-ID}).
import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

const sign = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("base64url");

export function issueToken(secret: string, tenant: string, conversationId: string) {
  const payload = Buffer.from(JSON.stringify({ t: tenant, c: conversationId })).toString("base64url");
  const body = `${VERSION}.${payload}`;
  return `${body}.${sign(secret, body)}`;
}

/** Gesprächs-ID, wenn das Token gültig ist und zum Tenant gehört, sonst null. */
export function verifyToken(secret: string, tenant: string, token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [version, payload, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(secret, `${version}.${payload}`));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!data || typeof data !== "object") return null;
    const { t, c } = data as Record<string, unknown>;
    return t === tenant && typeof c === "string" && c.length > 0 ? c : null;
  } catch {
    return null;
  }
}
