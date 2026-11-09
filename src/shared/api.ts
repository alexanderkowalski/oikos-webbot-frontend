// Vertrag der Webchat-API zwischen Chatfenster und BFF. Beide Seiten importieren diese Datei.
import { z } from "zod";

export const TRACKING_VALUE_MAX = 2048;

const trackingValue = z.string().trim().max(TRACKING_VALUE_MAX).optional();

/** Tracking-Daten der Elternseite, wie sie das Chatfenster per postMessage erhalten hat. */
export const TrackingSchema = z.object({
  location: trackingValue,
  entryPage: trackingValue,
  journeyId: trackingValue,
  userPseudoId: trackingValue,
});
export type Tracking = z.infer<typeof TrackingSchema>;

const requestId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, "requestId: 8 bis 64 Zeichen aus A-Z a-z 0-9 _ -");

export const CreateConversationRequestSchema = z.object({
  requestId,
  tracking: TrackingSchema.default({}),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const CreateConversationResponseSchema = z.object({ token: z.string() });
export type CreateConversationResponse = z.infer<typeof CreateConversationResponseSchema>;

export const SendMessageRequestSchema = z.object({
  requestId,
  // Die Länge prüft der BFF gegen das Limit des Tenants; hier nur eine harte Obergrenze.
  text: z.string().trim().min(1).max(64_000),
  tracking: TrackingSchema.default({}),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const HistoryMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

export const HistoryResponseSchema = z.object({ messages: z.array(HistoryMessageSchema) });
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

export const ERROR_CODES = [
  "bad_request",
  "forbidden",
  "not_found",
  "session_invalid",
  "message_too_long",
  "conversation_limit",
  "rate_limited",
  "busy",
  "unavailable",
  "generation_failed",
  "internal",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = z.object({ error: ApiErrorSchema });

/**
 * Ereignisse im SSE-Stream einer Antwort. Der SSE-Feldname `event` ist der Schlüssel,
 * `data` das JSON-Objekt, `id` die Sequenznummer der Runtime (für `?after=`).
 */
export const StreamEventSchemas = {
  started: z.object({ responseId: z.string() }),
  delta: z.object({ text: z.string() }),
  done: z.object({ status: z.enum(["completed", "incomplete", "cancelled"]) }),
  error: ApiErrorSchema,
  // Reserviert: erledigte Workflows / Gesprächsende, sobald die Runtime sie über die
  // Chat-API liefert. Wird heute nie gesendet; Inhalt wird dann festgelegt.
  signals: z.object({}).loose(),
} as const;
export type StreamEventName = keyof typeof StreamEventSchemas;
export type StreamEvent = {
  [K in StreamEventName]: { event: K; data: z.infer<(typeof StreamEventSchemas)[K]>; id?: string };
}[StreamEventName];

export const ColorsSchema = z.object({
  primary: z.string(),
  secondary: z.string(),
  headerText: z.string(),
  subtitleText: z.string(),
  userMessageText: z.string(),
  assistantLink: z.string(),
});

export const PresentationSchema = z.object({
  language: z.string(),
  assistantName: z.string(),
  subtitle: z.string(),
  avatarUrl: z.url().nullable(),
  colors: ColorsSchema,
  welcomeMessage: z.string().min(1),
  disclaimer: z.string().nullable(),
  messagePlaceholder: z.string(),
});

export const TextsSchema = z.object({
  send: z.string(),
  typing: z.string(),
  retry: z.string(),
  toggleTheme: z.string(),
  errors: z.object({
    generic: z.string(),
    unavailable: z.string(),
    messageTooLong: z.string(),
    conversationLimit: z.string(),
    rateLimited: z.string(),
    busy: z.string(),
    incomplete: z.string(),
    sessionExpired: z.string(),
  }),
});
export type Texts = z.infer<typeof TextsSchema>;

export const ConsentButtonsSchema = z.object({
  accepted: z.array(z.string()),
  denied: z.array(z.string()),
});

/** Alles, was das Chatfenster über seinen Tenant wissen darf. Keine Runtime-Werte. */
export const BootstrapSchema = z.object({
  tenant: z.string(),
  parentOrigins: z.array(z.string()),
  maxMessageLength: z.number().int().positive(),
  presentation: PresentationSchema,
  consentButtons: ConsentButtonsSchema,
  referrerHosts: z.array(z.string()),
  texts: TextsSchema,
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;
