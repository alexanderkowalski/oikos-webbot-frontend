// Tracking-Daten als Conversation-Metadaten. UpdateConversation ersetzt die Metadaten
// komplett, deshalb wird immer der vollständige aktuelle Stand zusammengeführt.
import type { Tracking } from "../shared/api";

export const METADATA_MAX_ENTRIES = 16;
export const METADATA_VALUE_MAX = 512;

export const METADATA_KEYS = {
  channel: "channel",
  entryPage: "entry_page",
  originInfo: "origin_info",
  journeyId: "journey_id",
  userPseudoId: "user_pseudo_id",
} as const;

export const CHANNEL = "webchat";

const clip = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? Array.from(trimmed).slice(0, METADATA_VALUE_MAX).join("") : undefined;
};

/** Metadaten für ein neues Gespräch. */
export function initialMetadata(tracking: Tracking) {
  return mergeTrackingMetadata({ [METADATA_KEYS.channel]: CHANNEL }, tracking) ?? { [METADATA_KEYS.channel]: CHANNEL };
}

/**
 * Regeln wie im alten Chatfenster: Einstiegsseite und JourneyID werden nur einmal gesetzt,
 * aktuelle Seite und UserPseudoID folgen dem neuesten Stand. Liefert null, wenn sich nichts ändert.
 * Fremde Schlüssel bleiben erhalten; neue Schlüssel kommen nur dazu, solange Platz ist.
 */
export function mergeTrackingMetadata(current: Record<string, string>, tracking: Tracking): Record<string, string> | null {
  const next = { ...current };
  const setOnce = (key: string, value: string | undefined) => {
    if (value && !next[key]) next[key] = value;
  };
  const follow = (key: string, value: string | undefined) => {
    if (value) next[key] = value;
  };

  setOnce(METADATA_KEYS.channel, CHANNEL);
  setOnce(METADATA_KEYS.entryPage, clip(tracking.entryPage ?? tracking.location));
  setOnce(METADATA_KEYS.journeyId, clip(tracking.journeyId));
  follow(METADATA_KEYS.originInfo, clip(tracking.location));
  follow(METADATA_KEYS.userPseudoId, clip(tracking.userPseudoId));

  for (const key of Object.keys(next)) {
    if (!(key in current) && Object.keys(next).length > METADATA_MAX_ENTRIES) delete next[key];
  }

  const changed =
    Object.keys(next).length !== Object.keys(current).length ||
    Object.entries(next).some(([key, value]) => current[key] !== value);
  return changed ? next : null;
}
