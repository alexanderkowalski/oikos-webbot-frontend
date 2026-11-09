// postMessage zur Elternseite (Website des Tenants). Format unverändert zum alten Chatfenster
// (oikos-bot-ui/types/tracking.ts): rein location/UserPseudoID/JourneyID, raus ga4Event.
import type { Tracking } from "../../shared/api";

export const TRACKING_STEPS = {
  sendMessage: "send_message",
  selectTopic: "select_topic",
  dataPolicy: "data_policy",
  linkClick: "link_click",
} as const;

export type TrackingStep = (typeof TRACKING_STEPS)[keyof typeof TRACKING_STEPS];

export type Ga4Event = {
  event: "ga4Event";
  eventName: "button_click";
  eventType: "chatbot";
  step: string;
  eventParameter1: "link_url";
  fieldValue1: string;
  eventParameter2?: "interactionOption1" | "UserPseudoID";
  fieldValue2?: string;
  eventParameter3: "JourneyID";
  fieldValue3: string;
};

const nonEmpty = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export function buildGa4Event(
  input: { step: string; interactionOption1?: string; linkUrl?: string },
  tracking: Tracking,
): Ga4Event {
  const event: Ga4Event = {
    event: "ga4Event",
    eventName: "button_click",
    eventType: "chatbot",
    step: input.step,
    eventParameter1: "link_url",
    fieldValue1: nonEmpty(input.linkUrl) ?? "n/a",
    eventParameter3: "JourneyID",
    fieldValue3: nonEmpty(tracking.journeyId) ?? "n/a",
  };
  const option = nonEmpty(input.interactionOption1);
  if (option) {
    event.eventParameter2 = "interactionOption1";
    event.fieldValue2 = option;
  }
  return event;
}

/**
 * Übernimmt eine Nachricht der Elternseite in den Tracking-Stand. Regeln wie im alten
 * Iframe.vue: JourneyID und Einstiegsseite nur einmal, UserPseudoID und aktuelle Seite
 * folgen dem neuesten Wert. Liefert null, wenn die Nachricht nichts Brauchbares enthält.
 */
export function mergeIncomingTracking(current: Tracking, data: unknown): Tracking | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  const location = nonEmpty(raw.location);
  const journeyId = nonEmpty(raw.JourneyID);
  const userPseudoId = nonEmpty(raw.UserPseudoID);
  if (!location && !journeyId && !userPseudoId) return null;
  return {
    entryPage: current.entryPage || location,
    location: location ?? current.location,
    journeyId: current.journeyId || journeyId,
    userPseudoId: userPseudoId ?? current.userPseudoId,
  };
}

export function originOf(url: string | undefined | null) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
