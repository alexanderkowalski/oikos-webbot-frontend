// Connect-Client für agent.conversations.v1.ResponsesService. Die drei Header kommen aus
// der Tenant-Konfiguration; der Browser kann sie nicht beeinflussen.
import { create } from "@bufbuild/protobuf";
import { type CallOptions, Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { Tenant } from "../config";
import { ListOrder, PublicErrorSchema } from "../gen/agent/common/v1/common_pb";
import {
  ContentPartSchema,
  type Item,
  MessageRole,
  ReasoningEffort,
  type ResponseEvent,
  ResponsesService,
} from "../gen/agent/conversations/v1/conversations_pb";
import { type IdTokenSource, idTokenInterceptor } from "./id-token";

// Laut Runtime-Doku: Eine Response dauert höchstens 150 s, Clients warten mindestens 160 s.
const DEADLINE_MS = 160_000;
const STREAM_ATTEMPTS = 3;
const PAGE_SIZE = 100;

export type RuntimeClient = ReturnType<typeof createRuntimeClient>;

export function createRuntimeClient(baseUrl: string, auth: { idToken?: IdTokenSource } = {}) {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "1.1",
    defaultTimeoutMs: DEADLINE_MS,
    interceptors: auth.idToken ? [idTokenInterceptor(auth.idToken)] : [],
  });
  const client = createClient(ResponsesService, transport);

  const options = (tenant: Tenant, signal?: AbortSignal): CallOptions => ({
    headers: {
      "x-api-key": tenant.apiKey,
      "x-runtime-tenant-id": tenant.runtime.tenantId,
      "x-runtime-agent-id": tenant.runtime.agentId,
    },
    signal,
  });

  // Stream mit Fortsetzen wie in der Console (frontend/src/data/chat-client.ts): Reißt die
  // Verbindung ab, geht es mit SubscribeResponseEvents ab der letzten Sequenz weiter.
  async function* resumable(
    open: (responseId: string | undefined, after: bigint | undefined) => AsyncIterable<ResponseEvent>,
    knownResponseId?: string,
  ): AsyncIterable<ResponseEvent> {
    let responseId = knownResponseId;
    let sequence: bigint | undefined;
    for (let attempt = 0; attempt < STREAM_ATTEMPTS; attempt++) {
      try {
        for await (const event of open(responseId, sequence)) {
          if (sequence !== undefined && event.sequenceNumber <= sequence) continue;
          sequence = event.sequenceNumber;
          if (event.event.case === "created") responseId = event.event.value.id;
          yield event;
          if (event.event.case === "finished") return;
        }
        throw new ConnectError("Der Antwortstream endete vor dem Abschluss.", Code.Unavailable);
      } catch (error) {
        const retry =
          attempt < STREAM_ATTEMPTS - 1 &&
          responseId !== undefined &&
          error instanceof ConnectError &&
          [Code.Unavailable, Code.Unknown].includes(error.code);
        if (!retry) throw error;
      }
    }
  }

  return {
    createConversation: (tenant: Tenant, input: { requestId: string; metadata: Record<string, string>; welcome: string }) =>
      client.createConversation(
        {
          requestId: input.requestId,
          metadata: input.metadata,
          items: [{ role: MessageRole.ASSISTANT, content: [create(ContentPartSchema, { part: { case: "text", value: input.welcome } })] }],
        },
        options(tenant),
      ),

    retrieveConversation: (tenant: Tenant, conversationId: string) => client.retrieveConversation({ conversationId }, options(tenant)),

    updateConversation: (tenant: Tenant, conversationId: string, metadata: Record<string, string>) =>
      client.updateConversation({ conversationId, metadata }, options(tenant)),

    retrieveResponse: (tenant: Tenant, responseId: string) => client.retrieveResponse({ responseId }, options(tenant)),

    /** Liest alle Verlaufsseiten. */
    async listItems(tenant: Tenant, conversationId: string, order: "asc" | "desc"): Promise<Item[]> {
      const items: Item[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await client.listConversationItems(
          { conversationId, after, limit: PAGE_SIZE, order: order === "asc" ? ListOrder.ASC : ListOrder.DESC },
          options(tenant),
        );
        items.push(...page.items);
        if (!page.hasMore || page.items.length === 0) return items;
        after = page.items.at(-1)?.id;
      }
    },

    streamResponse: (tenant: Tenant, input: { requestId: string; conversationId: string; text: string }) =>
      resumable((responseId, after) =>
        responseId
          ? client.subscribeResponseEvents({ responseId, startingAfter: after }, options(tenant))
          : client.streamResponse(
              {
                requestId: input.requestId,
                conversationId: input.conversationId,
                content: [create(ContentPartSchema, { part: { case: "text", value: input.text } })],
                model: tenant.model.name,
                reasoningEffort: ReasoningEffort[tenant.model.reasoningEffort],
                maxOutputTokens: tenant.model.maxOutputTokens,
              },
              options(tenant),
            ),
      ),

    subscribe: (tenant: Tenant, responseId: string) =>
      resumable(
        (id, after) => client.subscribeResponseEvents({ responseId: id ?? responseId, startingAfter: after }, options(tenant)),
        responseId,
      ),
  };
}

/** RPC-Fehler mit dem Detail agent.common.v1.PublicError, soweit vorhanden. */
export function describeRpcError(error: unknown) {
  const connect = ConnectError.from(error);
  const detail = connect.findDetails(PublicErrorSchema)[0];
  return { grpcCode: Code[connect.code], code: detail?.code, param: detail?.param, retryable: detail?.retryable ?? false, connect };
}
