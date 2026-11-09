/**
 * Client-IP hinter `trustedProxies` vertrauenswürdigen Proxies. Jeder Proxy hängt die Adresse,
 * von der er die Anfrage bekam, an X-Forwarded-For an. Vertrauenswürdig ist also nur der Eintrag,
 * den der äußerste vertrauenswürdige Proxy angehängt hat: der N-te von rechts. Alles links davon
 * kann der Client selbst geschickt haben.
 */
export function clientIp(forwardedFor: string | undefined, socketAddress: string | undefined, trustedProxies: number) {
  const fallback = socketAddress || "unknown";
  if (trustedProxies <= 0 || !forwardedFor) return fallback;
  const entries = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return fallback;
  return entries[Math.max(0, entries.length - trustedProxies)] ?? fallback;
}
