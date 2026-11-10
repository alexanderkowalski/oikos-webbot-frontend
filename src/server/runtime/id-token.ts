// Google-ID-Token für Aufrufe an die Runtime, wenn diese auf Cloud Run mit IAM geschützt ist
// (Rolle „Cloud Run Invoker“ für das Dienstkonto des BFF). Das Token kommt vom Metadata-Server
// der Instanz; ohne zusätzliche Bibliothek. Lokal läuft das über `gcloud run services proxy`.
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";

const METADATA_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const METADATA_TIMEOUT_MS = 5_000;
/** Token rechtzeitig vor Ablauf erneuern (Google-ID-Tokens gelten 1 Stunde). */
const REFRESH_BEFORE_MS = 5 * 60_000;
const FALLBACK_LIFETIME_MS = 55 * 60_000;

export type IdTokenSource = () => Promise<string>;

/** Ablaufzeit aus dem `exp`-Claim des JWT; die Signatur prüft die Runtime bzw. Cloud Run, nicht wir. */
function expiresAt(token: string, now: number) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    // kein lesbares JWT: Standardlaufzeit annehmen
  }
  return now + FALLBACK_LIFETIME_MS;
}

/** Liefert ein gültiges ID-Token, zwischengespeichert; parallele Anfragen teilen sich einen Abruf. */
export function createIdTokenSource(audience: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): IdTokenSource {
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function load() {
    let response: Response;
    try {
      response = await fetchImpl(`${METADATA_URL}?audience=${encodeURIComponent(audience)}&format=full`, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ConnectError("ID-Token: Metadata-Server nicht erreichbar.", Code.Unavailable, undefined, undefined, error);
    }
    if (!response.ok) throw new ConnectError(`ID-Token: Metadata-Server antwortet mit ${response.status}.`, Code.Unavailable);
    const token = (await response.text()).trim();
    if (!token) throw new ConnectError("ID-Token: leere Antwort vom Metadata-Server.", Code.Unavailable);
    cached = { token, expiresAt: expiresAt(token, now()) };
    return token;
  }

  return () => {
    if (cached && cached.expiresAt - REFRESH_BEFORE_MS > now()) return Promise.resolve(cached.token);
    pending ??= load().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Setzt `Authorization: Bearer <ID-Token>`; die Runtime selbst authentifiziert weiter über x-api-key. */
export function idTokenInterceptor(source: IdTokenSource): Interceptor {
  return (next) => async (request) => {
    request.header.set("authorization", `Bearer ${await source()}`);
    return next(request);
  };
}
