// Übersetzt ResponseEvents der Runtime in die Ereignisse der Webchat-API.
// Der Browser bekommt nur den Text der Assistenten-Nachrichten, keine Zwischenmeldungen
// (COMMENTARY) und kein Reasoning.

import type { StreamEvent, Texts } from "../../shared/api";
import { AssistantPhase, type Item, MessageRole, type ResponseEvent, ResponseStatus } from "../gen/agent/conversations/v1/conversations_pb";

export function isVisibleAssistantMessage(item: Item) {
  return (
    item.item.case === "message" && item.item.value.role === MessageRole.ASSISTANT && item.item.value.phase !== AssistantPhase.COMMENTARY
  );
}

export function messageText(item: Item) {
  if (item.item.case !== "message") return "";
  return item.item.value.content.map((part) => (part.part.case === "text" || part.part.case === "refusal" ? part.part.value : "")).join("");
}

const ITEM_SEPARATOR = "\n\n";

export type FinishedSummary = {
  responseId: string;
  status: keyof typeof ResponseStatus;
  errorCode?: string;
  inputTokens?: bigint;
  outputTokens?: bigint;
  reasoningTokens?: bigint;
};

export class ResponseEventMapper {
  private readonly emitted = new Map<string, string>();
  private lastItemId: string | undefined;
  finished: FinishedSummary | undefined;

  private readonly texts: Texts;

  constructor(texts: Texts) {
    this.texts = texts;
  }

  /** Alle Ereignisse eines Laufs der Reihe nach hineingeben, auch die vor `after`. */
  map(event: ResponseEvent): StreamEvent[] {
    const id = event.sequenceNumber.toString();
    const value = event.event;
    switch (value.case) {
      case "created":
        return [{ event: "started", data: { responseId: value.value.id }, id }];
      case "itemAdded":
        if (isVisibleAssistantMessage(value.value)) this.emitted.set(value.value.id, "");
        return [];
      case "textDelta":
      case "refusalDelta":
        return this.text(value.value.itemId, value.value.delta, id);
      case "itemDone": {
        // Falls Text nur im fertigen Item steht (z. B. gepuffert), den Rest nachliefern.
        const item = value.value;
        const sent = this.emitted.get(item.id);
        if (sent === undefined || !isVisibleAssistantMessage(item)) return [];
        const full = messageText(item);
        return full.startsWith(sent) && full.length > sent.length ? this.text(item.id, full.slice(sent.length), id) : [];
      }
      case "finished": {
        const response = value.value;
        const status =
          (Object.keys(ResponseStatus) as (keyof typeof ResponseStatus)[]).find((key) => ResponseStatus[key] === response.status) ??
          "UNSPECIFIED";
        this.finished = {
          responseId: response.id,
          status,
          errorCode: response.error?.code || undefined,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          reasoningTokens: response.usage?.reasoningTokens,
        };
        switch (response.status) {
          case ResponseStatus.COMPLETED:
            return [{ event: "done", data: { status: "completed" }, id }];
          case ResponseStatus.INCOMPLETE:
            return [{ event: "done", data: { status: "incomplete" }, id }];
          case ResponseStatus.CANCELLED:
            return [{ event: "done", data: { status: "cancelled" }, id }];
          default:
            return [
              {
                event: "error",
                data: { code: "generation_failed", message: this.texts.errors.generic, retryable: response.error?.retryable ?? true },
                id,
              },
            ];
        }
      }
      default:
        return [];
    }
  }

  private text(itemId: string, delta: string, id: string): StreamEvent[] {
    const sent = this.emitted.get(itemId);
    if (sent === undefined || delta === "") return [];
    const separator = this.lastItemId !== undefined && this.lastItemId !== itemId && this.anyTextSent() ? ITEM_SEPARATOR : "";
    this.emitted.set(itemId, sent + delta);
    this.lastItemId = itemId;
    return [{ event: "delta", data: { text: separator + delta }, id }];
  }

  private anyTextSent() {
    for (const text of this.emitted.values()) if (text) return true;
    return false;
  }
}
