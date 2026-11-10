// Client der Webchat-API. Spricht nur mit dem eigenen BFF unter /wc/api/:tenant.
import {
  type ApiError,
  ApiErrorResponseSchema,
  type Bootstrap,
  BootstrapSchema,
  CONVERSATION_TOKEN_HEADER,
  CreateConversationResponseSchema,
  type HistoryMessage,
  HistoryResponseSchema,
  type StreamEvent,
  type StreamEventName,
  StreamEventSchemas,
  type Tracking,
} from "../../shared/api";

export class ApiFailure extends Error {
  readonly error: ApiError;
  readonly status: number;

  constructor(error: ApiError, status: number) {
    super(error.code);
    this.error = error;
    this.status = status;
  }
}

/** Netzwerk weg oder Stream ohne Abschluss: darf fortgesetzt bzw. wiederholt werden. */
export class StreamInterrupted extends Error {}

const base = (tenant: string) => `/wc/api/${encodeURIComponent(tenant)}`;

async function call(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "omit" });
  } catch {
    throw new StreamInterrupted("network");
  }
  if (response.ok) return response;
  const body = ApiErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
  throw new ApiFailure(
    body.success ? body.data.error : { code: "internal", message: "", retryable: response.status >= 500 },
    response.status,
  );
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
  body: JSON.stringify(body),
});

export const newRequestId = () => crypto.randomUUID();

export const api = {
  async bootstrap(tenant: string): Promise<Bootstrap> {
    return BootstrapSchema.parse(await (await call(`${base(tenant)}/bootstrap`)).json());
  },

  async createConversation(tenant: string, requestId: string, tracking: Tracking): Promise<string> {
    const response = await call(`${base(tenant)}/conversations`, json({ requestId, tracking }));
    return CreateConversationResponseSchema.parse(await response.json()).token;
  },

  async history(tenant: string, token: string): Promise<HistoryMessage[]> {
    const response = await call(`${base(tenant)}/conversation/messages`, { headers: { [CONVERSATION_TOKEN_HEADER]: token } });
    return HistoryResponseSchema.parse(await response.json()).messages;
  },

  async send(tenant: string, token: string, body: { requestId: string; text: string; tracking: Tracking }, signal?: AbortSignal) {
    const init = json(body);
    return readEvents(
      await call(`${base(tenant)}/conversation/messages`, {
        ...init,
        headers: { ...init.headers, [CONVERSATION_TOKEN_HEADER]: token },
        signal,
      }),
    );
  },

  async resume(tenant: string, token: string, responseId: string, after: string | undefined, signal?: AbortSignal) {
    const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
    const url = `${base(tenant)}/conversation/responses/${encodeURIComponent(responseId)}/events${query}`;
    return readEvents(await call(url, { signal, headers: { Accept: "text/event-stream", [CONVERSATION_TOKEN_HEADER]: token } }));
  },
};

/** Liest einen SSE-Stream (text/event-stream) und liefert geprüfte Ereignisse. */
export async function* readEvents(response: Response): AsyncIterable<StreamEvent> {
  if (!response.body) throw new StreamInterrupted("no body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | undefined;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch {
        throw new StreamInterrupted("read");
      }
      if (chunk.done) return;
      buffer += chunk.value;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          const parsed = parseEvent(event, data.join("\n"), id);
          if (parsed) yield parsed;
          event = "message";
          data = [];
          id = undefined;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(name: string, raw: string, id: string | undefined): StreamEvent | undefined {
  if (!(name in StreamEventSchemas)) return undefined;
  const schema = StreamEventSchemas[name as StreamEventName];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? ({ event: name, data: parsed.data, id } as StreamEvent) : undefined;
}
