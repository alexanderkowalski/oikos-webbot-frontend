// Webchat-API unter /wc/api/:tenant. Der Browser spricht nur mit diesen Routen.
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  CreateConversationRequestSchema,
  SendMessageRequestSchema,
  type ApiError,
  type ErrorCode,
  type HistoryMessage,
  type StreamEvent,
} from "../../shared/api";
import { toBootstrap, type Config, type Tenant } from "../config";
import { MessageRole } from "../gen/agent/conversations/v1/conversations_pb";
import { clientIp } from "../guard/client-ip";
import { InflightRegistry, RateLimiter } from "../guard/rate-limit";
import { issueToken, verifyToken } from "../guard/token";
import { log } from "../log";
import { initialMetadata, mergeTrackingMetadata } from "../metadata";
import { describeRpcError, type RuntimeClient } from "../runtime/client";
import { isVisibleAssistantMessage, messageText, ResponseEventMapper } from "../runtime/events";

type Env = { Variables: { tenant: Tenant; ip: string } };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HISTORY_READS_PER_MINUTE = 30;
// Reicht für die längste erlaubte Nachricht plus Tracking-Daten mit Abstand.
const MAX_BODY_BYTES = 32 * 1024;

class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly body: ApiError;

  constructor(status: ContentfulStatusCode, body: ApiError) {
    super(body.code);
    this.status = status;
    this.body = body;
  }
}

const RUNTIME_REQUEST_PREFIX = "wc_";

export function createApi(config: Config, runtime: RuntimeClient) {
  const { env, tenants } = config;
  const limiter = new RateLimiter();
  const inflight = new InflightRegistry();
  setInterval(() => limiter.sweep(), MINUTE).unref();

  const fail = (tenant: Tenant | undefined, status: ContentfulStatusCode, code: ErrorCode, retryable = false): never => {
    const errors = tenant?.texts.errors;
    const message =
      {
        message_too_long: errors?.messageTooLong.replace("{max}", String(tenant?.limits.maxMessageLength)),
        conversation_limit: errors?.conversationLimit,
        rate_limited: errors?.rateLimited,
        busy: errors?.busy,
        unavailable: errors?.unavailable,
        session_invalid: errors?.sessionExpired,
      }[code as string] ??
      errors?.generic ??
      "Unbekannter Fehler.";
    throw new HttpError(status, { code, message, retryable });
  };

  /** RPC-Fehler der Runtime in eine Antwort an den Browser übersetzen. */
  const fromRpc = (tenant: Tenant, error: unknown, operation: string): never => {
    const rpc = describeRpcError(error);
    log.warn("runtime_error", { tenant: tenant.slug, operation, grpcCode: rpc.grpcCode, code: rpc.code, param: rpc.param });
    if (rpc.grpcCode === "NotFound") return fail(tenant, 404, "session_invalid");
    if (rpc.code === "conflict") return fail(tenant, 409, "busy", true);
    if (["Unavailable", "DeadlineExceeded", "Internal", "Unknown"].includes(rpc.grpcCode)) return fail(tenant, 503, "unavailable", true);
    return fail(tenant, 502, "internal");
  };

  const rateLimit = (tenant: Tenant, key: string, limit: number, windowMs: number) => {
    if (!limiter.hit(`${tenant.slug}:${key}`, limit, windowMs)) fail(tenant, 429, "rate_limited", true);
  };

  const conversationOf = (c: Context<Env>) => {
    const tenant = c.get("tenant");
    const conversationId = verifyToken(env.WEBCHAT_SIGNING_SECRET, tenant.slug, c.req.param("token") ?? "");
    return conversationId ?? fail(tenant, 404, "session_invalid");
  };

  const parseBody = async <T>(c: Context<Env>, schema: z.ZodType<T>): Promise<T> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? parsed.data : fail(c.get("tenant"), 400, "bad_request");
  };

  const app = new Hono<Env>({ strict: false });

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.body }, error.status);
    log.error("unhandled_error", { path: c.req.routePath, error: error.name });
    return c.json({ error: { code: "internal", message: "Interner Fehler.", retryable: true } satisfies ApiError }, 500);
  });

  // Nur das eigene Chatfenster darf die API benutzen. POST verlangt einen passenden Origin-Header;
  // GET ohne Origin (Browser senden ihn bei same-origin GET nicht) nur, wenn Sec-Fetch-Site passt.
  app.use("/:tenant/*", async (c, next) => {
    const tenant = tenants.get(c.req.param("tenant"));
    if (!tenant) return c.json({ error: { code: "not_found", message: "Unbekannter Tenant.", retryable: false } satisfies ApiError }, 404);
    c.set("tenant", tenant);

    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const allowed = origin
      ? env.WEBCHAT_PUBLIC_ORIGINS.includes(origin)
      : c.req.method === "GET" && (site === undefined || site === "same-origin" || site === "none");
    if (!allowed) fail(tenant, 403, "forbidden");

    const forwardedFor = c.req.header("x-forwarded-for");
    let socket: string | undefined;
    try {
      socket = getConnInfo(c).remote.address;
    } catch {
      // ohne Node-Socket (z. B. in Tests mit app.request)
    }
    c.set("ip", clientIp(forwardedFor, socket, env.WEBCHAT_TRUSTED_PROXY_COUNT));
    await next();
  });

  // Zu große Anfragen gar nicht erst einlesen. Die genaue Zeichengrenze prüft danach die Route.
  app.use("/:tenant/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c.get("tenant"), 413, "message_too_long") }));

  app.get("/:tenant/bootstrap", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.json(toBootstrap(c.get("tenant")));
  });

  app.post("/:tenant/conversations", async (c) => {
    const tenant = c.get("tenant");
    const body = await parseBody(c, CreateConversationRequestSchema);
    rateLimit(tenant, `create:${c.get("ip")}`, tenant.limits.conversationsPerHourPerIp, HOUR);
    try {
      const conversation = await runtime.createConversation(tenant, {
        requestId: RUNTIME_REQUEST_PREFIX + body.requestId,
        metadata: initialMetadata(body.tracking),
        welcome: tenant.presentation.welcomeMessage,
      });
      log.info("conversation_created", { tenant: tenant.slug, conversationId: conversation.id });
      return c.json({ token: issueToken(env.WEBCHAT_SIGNING_SECRET, tenant.slug, conversation.id) }, 201);
    } catch (error) {
      return fromRpc(tenant, error, "CreateConversation");
    }
  });

  app.get("/:tenant/conversations/:token/messages", async (c) => {
    const tenant = c.get("tenant");
    const conversationId = conversationOf(c);
    rateLimit(tenant, `history:${c.get("ip")}`, HISTORY_READS_PER_MINUTE, MINUTE);
    try {
      const items = await runtime.listItems(tenant, conversationId, "asc");
      const messages: HistoryMessage[] = items.flatMap((item) => {
        if (item.item.case !== "message") return [];
        const user = item.item.value.role === MessageRole.USER;
        if (!user && !isVisibleAssistantMessage(item)) return [];
        const text = messageText(item);
        return text ? [{ id: item.id, role: user ? "user" : "assistant", text }] : [];
      });
      c.header("Cache-Control", "no-store");
      return c.json({ messages });
    } catch (error) {
      return fromRpc(tenant, error, "ListConversationItems");
    }
  });

  app.post("/:tenant/conversations/:token/messages", async (c) => {
    const tenant = c.get("tenant");
    const receivedAt = performance.now();
    const conversationId = conversationOf(c);
    const body = await parseBody(c, SendMessageRequestSchema);
    if (Array.from(body.text).length > tenant.limits.maxMessageLength) fail(tenant, 413, "message_too_long");
    const ip = c.get("ip");
    rateLimit(tenant, `msg-ip:${ip}`, tenant.limits.messagesPerMinutePerIp, MINUTE);
    rateLimit(tenant, `msg-conv:${conversationId}`, tenant.limits.messagesPerMinutePerConversation, MINUTE);
    if (!inflight.acquire(conversationId, body.requestId)) fail(tenant, 409, "busy", true);

    let released = false;
    const release = () => {
      if (!released) inflight.release(conversationId, body.requestId);
      released = true;
    };

    try {
      const max = tenant.limits.maxUserMessagesPerConversation;
      const [items] = await Promise.all([
        runtime.listItems(tenant, conversationId, "desc", (page) => countUserMessages(page) >= max),
        syncTracking(tenant, conversationId, body.tracking),
      ]);
      if (countUserMessages(items) >= max) {
        log.info("conversation_limit_reached", { tenant: tenant.slug, conversationId });
        fail(tenant, 429, "conversation_limit");
      }
    } catch (error) {
      release();
      if (error instanceof HttpError) throw error;
      return fromRpc(tenant, error, "ListConversationItems");
    }

    return streamSSE(c, async (stream) => {
      let clientGone = false;
      stream.onAbort(() => {
        clientGone = true;
      });
      const send = async (event: StreamEvent) => {
        if (clientGone) return;
        try {
          await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data), id: event.id });
        } catch {
          clientGone = true;
        }
      };

      // Die Antwort läuft in der Runtime weiter, auch wenn der Browser die Verbindung verliert.
      // Der BFF liest den Stream trotzdem zu Ende, damit Sperre und Messwerte stimmen.
      const mapper = new ResponseEventMapper(tenant.texts);
      let firstTokenMs: number | undefined;
      try {
        for await (const event of runtime.streamResponse(tenant, {
          requestId: RUNTIME_REQUEST_PREFIX + body.requestId,
          conversationId,
          text: body.text,
        })) {
          for (const out of mapper.map(event)) {
            if (out.event === "delta" && firstTokenMs === undefined) firstTokenMs = Math.round(performance.now() - receivedAt);
            await send(out);
          }
        }
      } catch (error) {
        const rpc = describeRpcError(error);
        const code: ErrorCode = rpc.code === "conflict" ? "busy" : rpc.grpcCode === "NotFound" ? "session_invalid" : "unavailable";
        log.warn("runtime_error", { tenant: tenant.slug, operation: "StreamResponse", conversationId, grpcCode: rpc.grpcCode, code: rpc.code, param: rpc.param });
        await send({ event: "error", data: streamError(tenant, code) });
      } finally {
        release();
        const finished = mapper.finished;
        log.info("response", {
          tenant: tenant.slug,
          conversationId,
          responseId: finished?.responseId,
          status: finished?.status ?? "ABORTED",
          errorCode: finished?.errorCode,
          firstTokenMs,
          totalMs: Math.round(performance.now() - receivedAt),
          inputTokens: finished?.inputTokens,
          outputTokens: finished?.outputTokens,
          reasoningTokens: finished?.reasoningTokens,
          clientGone,
        });
      }
    });
  });

  app.get("/:tenant/conversations/:token/responses/:responseId/events", async (c) => {
    const tenant = c.get("tenant");
    const conversationId = conversationOf(c);
    const responseId = c.req.param("responseId");
    const after = z.coerce.bigint().min(0n).optional().safeParse(c.req.query("after") || undefined);
    if (!after.success) fail(tenant, 400, "bad_request");
    rateLimit(tenant, `history:${c.get("ip")}`, HISTORY_READS_PER_MINUTE, MINUTE);
    try {
      const response = await runtime.retrieveResponse(tenant, responseId);
      if (response.conversationId !== conversationId) fail(tenant, 404, "not_found");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return fromRpc(tenant, error, "RetrieveResponse");
    }

    return streamSSE(c, async (stream) => {
      let clientGone = false;
      stream.onAbort(() => {
        clientGone = true;
      });
      // Immer ab Sequenz 0 lesen, damit der Mapper die Items kennt; gesendet wird erst nach `after`.
      const mapper = new ResponseEventMapper(tenant.texts);
      try {
        for await (const event of runtime.subscribe(tenant, responseId)) {
          if (clientGone) return;
          const visible = after.data === undefined || event.sequenceNumber > after.data;
          for (const out of mapper.map(event)) {
            if (visible) await stream.writeSSE({ event: out.event, data: JSON.stringify(out.data), id: out.id });
          }
        }
      } catch (error) {
        const rpc = describeRpcError(error);
        log.warn("runtime_error", { tenant: tenant.slug, operation: "SubscribeResponseEvents", conversationId, grpcCode: rpc.grpcCode, code: rpc.code });
        if (!clientGone) {
          await stream.writeSSE({ event: "error", data: JSON.stringify(streamError(tenant, "unavailable")) }).catch(() => {});
        }
      }
    });
  });

  /** Tracking-Daten in die Metadaten übernehmen; Fehler hier blockieren die Nachricht nicht. */
  async function syncTracking(tenant: Tenant, conversationId: string, tracking: z.infer<typeof SendMessageRequestSchema>["tracking"]) {
    if (!Object.values(tracking).some(Boolean)) return;
    try {
      const conversation = await runtime.retrieveConversation(tenant, conversationId);
      const next = mergeTrackingMetadata(conversation.metadata, tracking);
      if (next) await runtime.updateConversation(tenant, conversationId, next);
    } catch (error) {
      const rpc = describeRpcError(error);
      if (rpc.grpcCode === "NotFound") throw error;
      log.warn("tracking_sync_failed", { tenant: tenant.slug, conversationId, grpcCode: rpc.grpcCode, code: rpc.code });
    }
  }

  function streamError(tenant: Tenant, code: ErrorCode): ApiError {
    const errors = tenant.texts.errors;
    const message = code === "busy" ? errors.busy : code === "session_invalid" ? errors.sessionExpired : code === "unavailable" ? errors.unavailable : errors.generic;
    return { code, message, retryable: code !== "session_invalid" };
  }

  return app;
}

function countUserMessages(items: { item: { case: string | undefined; value?: unknown } }[]) {
  return items.filter((item) => item.item.case === "message" && (item.item.value as { role: number }).role === MessageRole.USER).length;
}
