import { create, type MessageInitShape } from "@bufbuild/protobuf";

type EventInit = MessageInitShape<typeof ResponseEventSchema>["event"];
import { describe, expect, it } from "vitest";
import {
  AssistantPhase,
  ItemSchema,
  MessageRole,
  ResponseEventSchema,
  ResponseSchema,
  ResponseStatus,
  type ResponseEvent,
} from "../src/server/gen/agent/conversations/v1/conversations_pb";
import { clientIp } from "../src/server/guard/client-ip";
import { InflightRegistry, RateLimiter } from "../src/server/guard/rate-limit";
import { issueToken, verifyToken } from "../src/server/guard/token";
import { mergeTrackingMetadata } from "../src/server/metadata";
import { ResponseEventMapper } from "../src/server/runtime/events";
import { parseMessage } from "../src/web/lib/markup";
import { buildGa4Event, mergeIncomingTracking } from "../src/web/lib/tracking";
import { texts } from "./fixtures";

describe("parseMessage", () => {
  const consent =
    "Es gelten die {{Newsletterbedingungen}}(https://www.hanse-haus.de/de/ds-hinweise-newsletter/) und [Datenschutz](https://example.com/ds). [✅ Ich akzeptiere][❌ Ich akzeptiere nicht]";

  it("macht aus {{Text}}(url) und [Text](url) Links und aus [Text] Buttons", () => {
    const { markdown, buttons } = parseMessage(consent);
    expect(markdown).toBe(
      "Es gelten die [Newsletterbedingungen](https://www.hanse-haus.de/de/ds-hinweise-newsletter/) und [Datenschutz](https://example.com/ds).",
    );
    expect(buttons).toEqual(["✅ Ich akzeptiere", "❌ Ich akzeptiere nicht"]);
  });

  it("erkennt Buttons auf eigenen Zeilen", () => {
    const { markdown, buttons } = parseMessage("Wie kann ich helfen?\n[📄 Infomaterial erhalten]\n[📅 Beratungsgespräch vereinbaren]\n");
    expect(markdown).toBe("Wie kann ich helfen?");
    expect(buttons).toEqual(["📄 Infomaterial erhalten", "📅 Beratungsgespräch vereinbaren"]);
  });

  it("lässt Bilder und leere Klammern stehen", () => {
    expect(parseMessage("![Logo](https://x/y.png) [ ]").buttons).toEqual([]);
  });

  it("blendet halbe Buttons und Links am Ende eines laufenden Streams aus", () => {
    expect(parseMessage("Bitte wählen: [✅ Ich akz", true).markdown).toBe("Bitte wählen:");
    expect(parseMessage("Es gelten die {{Newsletterbed", true).markdown).toBe("Es gelten die");
  });
});

describe("Conversation-Token", () => {
  const secret = "x".repeat(32);
  it("gilt nur für den Tenant, für den es ausgestellt wurde", () => {
    const token = issueToken(secret, "hh", "conv_1");
    expect(verifyToken(secret, "hh", token)).toBe("conv_1");
    expect(verifyToken(secret, "bz", token)).toBeNull();
    expect(verifyToken("y".repeat(32), "hh", token)).toBeNull();
  });
  it("lehnt veränderte Tokens ab", () => {
    const [v, , sig] = issueToken(secret, "hh", "conv_1").split(".");
    const forged = Buffer.from(JSON.stringify({ t: "hh", c: "conv_2" })).toString("base64url");
    expect(verifyToken(secret, "hh", `${v}.${forged}.${sig}`)).toBeNull();
    expect(verifyToken(secret, "hh", "kaputt")).toBeNull();
  });
});

describe("clientIp", () => {
  it("nimmt ohne vertrauenswürdige Proxies die Socket-Adresse", () => {
    expect(clientIp("1.1.1.1", "10.0.0.1", 0)).toBe("10.0.0.1");
  });
  it("nimmt den N-ten Eintrag von rechts, nicht den ersten", () => {
    // Client fälscht "6.6.6.6"; der Load Balancer hängt die echte IP und seine eigene an.
    expect(clientIp("6.6.6.6, 203.0.113.7, 35.191.0.1", "169.254.1.1", 2)).toBe("203.0.113.7");
    expect(clientIp("203.0.113.7", "10.0.0.1", 1)).toBe("203.0.113.7");
  });
  it("fällt bei zu kurzem Header auf den ersten Eintrag zurück", () => {
    expect(clientIp("203.0.113.7", "10.0.0.1", 3)).toBe("203.0.113.7");
  });
});

describe("RateLimiter / InflightRegistry", () => {
  it("sperrt nach dem Limit bis zum nächsten Fenster", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    expect([1, 2, 3].map(() => limiter.hit("k", 2, 1000))).toEqual([true, true, false]);
    now = 1000;
    expect(limiter.hit("k", 2, 1000)).toBe(true);
  });
  it("lässt je Gespräch nur eine Anfrage zu, Wiederholungen derselben aber durch", () => {
    const inflight = new InflightRegistry();
    expect(inflight.acquire("c", "r1")).toBe(true);
    expect(inflight.acquire("c", "r2")).toBe(false);
    expect(inflight.acquire("c", "r1")).toBe(true);
    inflight.release("c", "r1");
    expect(inflight.acquire("c", "r2")).toBe(true);
  });
});

describe("mergeTrackingMetadata", () => {
  it("setzt Einstiegsseite und JourneyID nur einmal, Seite und UserPseudoID folgen", () => {
    const first = mergeTrackingMetadata({ channel: "webchat" }, { location: "https://a/1", journeyId: "j1" });
    expect(first).toEqual({ channel: "webchat", entry_page: "https://a/1", origin_info: "https://a/1", journey_id: "j1" });
    const second = mergeTrackingMetadata(first!, { location: "https://a/2", journeyId: "j2", userPseudoId: "u1" });
    expect(second).toEqual({ channel: "webchat", entry_page: "https://a/1", origin_info: "https://a/2", journey_id: "j1", user_pseudo_id: "u1" });
  });
  it("meldet keine Änderung, wenn alles gleich ist", () => {
    const current = { channel: "webchat", entry_page: "https://a/1", origin_info: "https://a/1" };
    expect(mergeTrackingMetadata(current, { location: "https://a/1" })).toBeNull();
  });
  it("kürzt Werte auf 512 Zeichen und hält fremde Schlüssel und das Limit von 16 ein", () => {
    const current = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, "v"]));
    const next = mergeTrackingMetadata(current, { location: `https://a/${"x".repeat(600)}`, journeyId: "j" })!;
    expect(Object.keys(next)).toHaveLength(16);
    for (let i = 0; i < 15; i++) expect(next[`k${i}`]).toBe("v");
  });
});

describe("ResponseEventMapper", () => {
  const ev = (sequenceNumber: number, event: EventInit) => create(ResponseEventSchema, { sequenceNumber: BigInt(sequenceNumber), event });
  const message = (id: string, phase: AssistantPhase, text = "") =>
    create(ItemSchema, {
      id,
      item: { case: "message", value: { role: MessageRole.ASSISTANT, phase, content: text ? [{ part: { case: "text", value: text } }] : [] } },
    });
  const finished = (status: ResponseStatus, error?: { code: string; retryable: boolean }) =>
    create(ResponseSchema, { id: "resp_1", status, error: error ? { code: error.code, message: "", retryable: error.retryable } : undefined });

  it("liefert started, nur sichtbare Deltas und done", () => {
    const mapper = new ResponseEventMapper(texts);
    const out = [
      ev(0, { case: "created", value: create(ResponseSchema, { id: "resp_1" }) }),
      ev(1, { case: "itemAdded", value: message("c1", AssistantPhase.COMMENTARY) }),
      ev(2, { case: "textDelta", value: { itemId: "c1", contentIndex: 0, delta: "Ich schaue nach …" } }),
      ev(3, { case: "itemAdded", value: message("m1", AssistantPhase.FINAL_ANSWER) }),
      ev(4, { case: "textDelta", value: { itemId: "m1", contentIndex: 0, delta: "Hallo" } }),
      ev(5, { case: "itemDone", value: message("m1", AssistantPhase.FINAL_ANSWER, "Hallo!") }),
      ev(6, { case: "finished", value: finished(ResponseStatus.COMPLETED) }),
    ].flatMap((event) => mapper.map(event));
    expect(out).toEqual([
      { event: "started", data: { responseId: "resp_1" }, id: "0" },
      { event: "delta", data: { text: "Hallo" }, id: "4" },
      { event: "delta", data: { text: "!" }, id: "5" },
      { event: "done", data: { status: "completed" }, id: "6" },
    ]);
  });

  it("trennt mehrere Antwort-Nachrichten mit einer Leerzeile", () => {
    const mapper = new ResponseEventMapper(texts);
    const out = [
      ev(1, { case: "itemAdded", value: message("a", AssistantPhase.FINAL_ANSWER) }),
      ev(2, { case: "textDelta", value: { itemId: "a", contentIndex: 0, delta: "Eins" } }),
      ev(3, { case: "itemAdded", value: message("b", AssistantPhase.FINAL_ANSWER) }),
      ev(4, { case: "textDelta", value: { itemId: "b", contentIndex: 0, delta: "Zwei" } }),
    ].flatMap((event) => mapper.map(event));
    expect(out.map((event) => (event.event === "delta" ? event.data.text : ""))).toEqual(["Eins", "\n\nZwei"]);
  });

  it("übernimmt Token-Verbrauch inklusive Reasoning für das Log", () => {
    const mapper = new ResponseEventMapper(texts);
    const response = create(ResponseSchema, {
      id: "resp_1",
      status: ResponseStatus.COMPLETED,
      usage: { inputTokens: 50_000n, outputTokens: 900n, reasoningTokens: 600n },
    });
    mapper.map(ev(7, { case: "finished", value: response }));
    expect(mapper.finished).toMatchObject({ inputTokens: 50_000n, outputTokens: 900n, reasoningTokens: 600n });
  });

  it("macht aus FAILED einen Fehler mit retryable der Runtime", () => {
    const mapper = new ResponseEventMapper(texts);
    const [out] = mapper.map(ev(9, { case: "finished", value: finished(ResponseStatus.FAILED, { code: "provider_unavailable", retryable: true }) }));
    expect(out).toEqual({ event: "error", data: { code: "generation_failed", message: texts.errors.generic, retryable: true }, id: "9" });
    expect(mapper.finished).toMatchObject({ status: "FAILED", errorCode: "provider_unavailable" });
  });
});

describe("Tracking der Elternseite", () => {
  it("übernimmt JourneyID und Einstiegsseite einmal, Seite und UserPseudoID laufend", () => {
    const first = mergeIncomingTracking({}, { location: "https://a/1", JourneyID: "j1" })!;
    const second = mergeIncomingTracking(first, { location: "https://a/2", JourneyID: "j2", UserPseudoID: "u1" })!;
    expect(second).toEqual({ entryPage: "https://a/1", location: "https://a/2", journeyId: "j1", userPseudoId: "u1" });
    expect(mergeIncomingTracking(second, { foo: 1 })).toBeNull();
  });
  it("baut ga4Event im bisherigen Format", () => {
    expect(buildGa4Event({ step: "data_policy", interactionOption1: "datapolicy_accepted" }, { journeyId: "j1" })).toEqual({
      event: "ga4Event",
      eventName: "button_click",
      eventType: "chatbot",
      step: "data_policy",
      eventParameter1: "link_url",
      fieldValue1: "n/a",
      eventParameter2: "interactionOption1",
      fieldValue2: "datapolicy_accepted",
      eventParameter3: "JourneyID",
      fieldValue3: "j1",
    });
    expect(buildGa4Event({ step: "link_click", linkUrl: "https://x" }, {})).toMatchObject({ fieldValue1: "https://x", fieldValue3: "n/a" });
  });
});
