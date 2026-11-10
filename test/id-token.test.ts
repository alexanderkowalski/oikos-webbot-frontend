import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { createIdTokenSource, idTokenInterceptor } from "../src/server/runtime/id-token";

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

function metadataServer(tokens: string[]) {
  const requests: { url: string; flavor: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, flavor: new Headers(init?.headers).get("metadata-flavor") });
    return new Response(tokens.shift() ?? "", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("ID-Token für die Runtime", () => {
  it("holt das Token mit Audience vom Metadata-Server und speichert es zwischen", async () => {
    let now = 0;
    const { fetchImpl, requests } = metadataServer([jwt(3600), jwt(7200)]);
    const source = createIdTokenSource("https://runtime-abc.a.run.app", fetchImpl, () => now);

    const [a, b] = await Promise.all([source(), source()]);
    expect(a).toBe(jwt(3600));
    expect(b).toBe(a);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.flavor).toBe("Google");
    expect(requests[0]?.url).toContain("audience=https%3A%2F%2Fruntime-abc.a.run.app");

    now = 3000 * 1000; // 10 Minuten vor Ablauf: noch aus dem Zwischenspeicher
    expect(await source()).toBe(jwt(3600));
    expect(requests).toHaveLength(1);

    now = 3400 * 1000; // weniger als 5 Minuten vor Ablauf: neu holen
    expect(await source()).toBe(jwt(7200));
    expect(requests).toHaveLength(2);
  });

  it("meldet Fehler des Metadata-Servers als Unavailable (wiederholbar)", async () => {
    const source = createIdTokenSource("https://x.run.app", (async () => new Response("", { status: 404 })) as typeof fetch);
    await expect(source()).rejects.toSatisfy((error) => error instanceof ConnectError && error.code === Code.Unavailable);
  });

  it("setzt den Authorization-Header und lässt x-api-key unberührt", async () => {
    const header = new Headers({ "x-api-key": "key-hh" });
    const next = async (request: { header: Headers }) => request;
    const intercept = idTokenInterceptor(async () => "tok");
    await intercept(next as never)({ header } as never);
    expect(header.get("authorization")).toBe("Bearer tok");
    expect(header.get("x-api-key")).toBe("key-hh");
  });
});
