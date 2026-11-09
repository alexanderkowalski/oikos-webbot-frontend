import { create, type MessageInitShape } from "@bufbuild/protobuf";

type EventInit = MessageInitShape<typeof ResponseEventSchema>["event"];
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import {
  AssistantPhase,
  ConversationSchema,
  ItemSchema,
  MessageRole,
  ResponseEventSchema,
  ResponseSchema,
  ResponseStatus,
  type Item,
  type ResponseEvent,
} from "../src/server/gen/agent/conversations/v1/conversations_pb";
import type { RuntimeClient } from "../src/server/runtime/client";

const ORIGIN = "http://chat.test";

function setup(options: { items?: Item[]; events?: () => AsyncIterable<ResponseEvent> } = {}) {
  const tenantsDir = mkdtempSync(join(tmpdir(), "wc-tenants-"));
  const hh = JSON.parse(readFileSync("tenants/hh.json", "utf8"));
  writeFileSync(join(tenantsDir, "hh.json"), JSON.stringify(hh));
  writeFileSync(join(tenantsDir, "other.json"), JSON.stringify({ ...hh, runtime: { ...hh.runtime, tenantId: "other", apiKeyEnv: "KEY_OTHER" }, parentOrigins: [] }));
  const webDir = mkdtempSync(join(tmpdir(), "wc-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>t</title>");

  const config = loadConfig({
    WEBCHAT_PUBLIC_ORIGINS: ORIGIN,
    WEBCHAT_RUNTIME_URL: "http://runtime.test",
    WEBCHAT_SIGNING_SECRET: "s".repeat(32),
    WEBCHAT_TENANTS_DIR: tenantsDir,
    WEBCHAT_WEB_DIR: webDir,
    WEBCHAT_RUNTIME_API_KEY_HH: "key-hh",
    KEY_OTHER: "key-other",
  });

  const calls: { method: string; args: unknown }[] = [];
  const runtime = {
    createConversation: async (_tenant: unknown, input: unknown) => {
      calls.push({ method: "createConversation", args: input });
      return create(ConversationSchema, { id: "conv_1" });
    },
    retrieveConversation: async () => create(ConversationSchema, { id: "conv_1", metadata: { channel: "webchat" } }),
    updateConversation: async (_tenant: unknown, _id: string, metadata: unknown) => {
      calls.push({ method: "updateConversation", args: metadata });
      return create(ConversationSchema, { id: "conv_1" });
    },
    retrieveResponse: async () => create(ResponseSchema, { id: "resp_1", conversationId: "conv_1" }),
    listItems: async () => options.items ?? [],
    streamResponse: (_tenant: unknown, input: unknown) => {
      calls.push({ method: "streamResponse", args: input });
      return (options.events ?? defaultEvents)();
    },
    subscribe: () => defaultEvents(),
  } as unknown as RuntimeClient;

  return { app: createApp(config, runtime), calls };
}

async function* defaultEvents(): AsyncIterable<ResponseEvent> {
  const ev = (n: number, event: EventInit) => create(ResponseEventSchema, { sequenceNumber: BigInt(n), event });
  yield ev(0, { case: "created", value: create(ResponseSchema, { id: "resp_1" }) });
  yield ev(1, {
    case: "itemAdded",
    value: create(ItemSchema, { id: "m1", item: { case: "message", value: { role: MessageRole.ASSISTANT, phase: AssistantPhase.FINAL_ANSWER } } }),
  });
  yield ev(2, { case: "textDelta", value: { itemId: "m1", contentIndex: 0, delta: "Guten Tag!" } });
  yield ev(3, { case: "finished", value: create(ResponseSchema, { id: "resp_1", status: ResponseStatus.COMPLETED }) });
}

const userItem = (i: number) =>
  create(ItemSchema, { id: `u${i}`, item: { case: "message", value: { role: MessageRole.USER, content: [{ part: { case: "text", value: "hi" } }] } } });

const post = (app: ReturnType<typeof setup>["app"], path: string, body: unknown, origin: string | null = ORIGIN) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });

async function newToken(app: ReturnType<typeof setup>["app"]) {
  const response = await post(app, "/wc/api/hh/conversations", { requestId: "req-create-1", tracking: { location: "https://www.hanse-haus.de/x" } });
  return ((await response.json()) as { token: string }).token;
}

describe("Webchat-API", () => {
  it("lehnt POST ohne oder mit fremdem Origin ab", async () => {
    const { app } = setup();
    expect((await post(app, "/wc/api/hh/conversations", { requestId: "req-create-1" }, null)).status).toBe(403);
    expect((await post(app, "/wc/api/hh/conversations", { requestId: "req-create-1" }, "https://evil.test")).status).toBe(403);
  });

  it("liefert Bootstrap ohne Runtime-Werte", async () => {
    const { app } = setup();
    const body = await (await app.request("/wc/api/hh/bootstrap", { headers: { Origin: ORIGIN } })).text();
    expect(body).toContain("Clara Lehmann");
    expect(body).not.toContain("key-hh");
    expect(body).not.toContain("gpt-6-luna");
    expect(body).not.toContain("webbot");
  });

  it("legt das Gespräch mit Willkommensnachricht und Tracking-Metadaten an", async () => {
    const { app, calls } = setup();
    const token = await newToken(app);
    expect(token).toMatch(/^v1\./);
    expect(calls[0]).toEqual({
      method: "createConversation",
      args: {
        requestId: "wc_req-create-1",
        metadata: { channel: "webchat", entry_page: "https://www.hanse-haus.de/x", origin_info: "https://www.hanse-haus.de/x" },
        welcome: expect.stringContaining("Ich bin Clara Lehmann"),
      },
    });
  });

  it("streamt die Antwort als SSE", async () => {
    const { app, calls } = setup();
    const token = await newToken(app);
    const response = await post(app, `/wc/api/hh/conversations/${token}/messages`, { requestId: "req-msg-1", text: "Hallo", tracking: {} });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: started");
    expect(body).toContain('data: {"text":"Guten Tag!"}');
    expect(body).toContain('event: done\ndata: {"status":"completed"}\nid: 3');
    expect(calls.find((call) => call.method === "streamResponse")?.args).toEqual({ requestId: "wc_req-msg-1", conversationId: "conv_1", text: "Hallo" });
  });

  it("akzeptiert kein Token eines anderen Tenants", async () => {
    const { app } = setup();
    const token = await newToken(app);
    const response = await post(app, `/wc/api/other/conversations/${token}/messages`, { requestId: "req-msg-1", text: "Hallo" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "session_invalid" } });
  });

  it("prüft Nachrichtenlänge und Gesprächslimit", async () => {
    const full = setup({ items: Array.from({ length: 50 }, (_, i) => userItem(i)) });
    const token = await newToken(full.app);
    const tooLong = await post(full.app, `/wc/api/hh/conversations/${token}/messages`, { requestId: "req-msg-1", text: "x".repeat(2001) });
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toMatchObject({ error: { code: "message_too_long", message: expect.stringContaining("2000") } });
    const limit = await post(full.app, `/wc/api/hh/conversations/${token}/messages`, { requestId: "req-msg-2", text: "Hallo" });
    expect(limit.status).toBe(429);
    expect(await limit.json()).toMatchObject({ error: { code: "conversation_limit", retryable: false } });
    expect(full.calls.some((call) => call.method === "streamResponse")).toBe(false);
  });

  it("lehnt Anfragen über 32 KB ab, bevor sie eingelesen werden", async () => {
    const { app, calls } = setup();
    const token = await newToken(app);
    const body = JSON.stringify({ requestId: "req-msg-1", text: "x".repeat(40_000) });
    const expected = { error: { code: "message_too_long", message: expect.stringContaining("2000"), retryable: false } };

    const streamed = await post(app, `/wc/api/hh/conversations/${token}/messages`, JSON.parse(body));
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toMatchObject(expected);

    const declared = await app.request(`/wc/api/hh/conversations/${token}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, "Content-Length": String(body.length) },
      body,
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject(expected);
    expect(calls.some((call) => call.method === "streamResponse")).toBe(false);
  });

  it("lehnt eine zweite Nachricht ab, solange eine Antwort läuft", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { app } = setup({
      events: async function* () {
        await gate;
        yield* defaultEvents();
      },
    });
    const token = await newToken(app);
    const first = post(app, `/wc/api/hh/conversations/${token}/messages`, { requestId: "req-msg-1", text: "Eins" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post(app, `/wc/api/hh/conversations/${token}/messages`, { requestId: "req-msg-2", text: "Zwei" });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "busy" } });
    release();
    expect(await (await first).text()).toContain("event: done");
  });

  it("schreibt geänderte Tracking-Daten in die Metadaten", async () => {
    const { app, calls } = setup();
    const token = await newToken(app);
    await (await post(app, `/wc/api/hh/conversations/${token}/messages`, { requestId: "req-msg-1", text: "Hallo", tracking: { location: "https://www.hanse-haus.de/y", journeyId: "j1" } })).text();
    expect(calls.find((call) => call.method === "updateConversation")?.args).toEqual({
      channel: "webchat",
      entry_page: "https://www.hanse-haus.de/y",
      origin_info: "https://www.hanse-haus.de/y",
      journey_id: "j1",
    });
  });

  it("liefert das iframe nur für bekannte Tenants, mit frame-ancestors", async () => {
    const { app } = setup();
    const page = await app.request("/iframe/hh");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors https://www.hanse-haus.de");
    expect((await app.request("/iframe/hh/")).status).toBe(200);
    expect((await app.request("/iframe/other")).headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect((await app.request("/iframe/xx")).status).toBe(404);
  });
});
