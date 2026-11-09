import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, StreamEvent, Tracking } from "../../shared/api";
import { api, ApiFailure, newRequestId, StreamInterrupted } from "./api";
import type { Storage } from "./storage";

export type ChatMessage = { key: string; role: "user" | "assistant"; text: string; streaming?: boolean };
export type ChatNotice = { message: string; retry?: () => void };

type Pending = { responseId: string };

const RESUME_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let keys = 0;
const nextKey = () => `m${++keys}`;

export function useChat(bootstrap: Bootstrap, storage: Storage, currentTracking: () => Tracking) {
  const tenant = bootstrap.tenant;
  const welcome = useCallback(
    (): ChatMessage => ({ key: "welcome", role: "assistant", text: bootstrap.presentation.welcomeMessage }),
    [bootstrap],
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<ChatNotice | null>(null);
  const token = useRef<string | undefined>(storage.get<string>("token"));

  const update = (key: string, change: (message: ChatMessage) => ChatMessage) =>
    setMessages((list) => list.map((message) => (message.key === key ? change(message) : message)));

  const forgetConversation = useCallback(() => {
    token.current = undefined;
    storage.set("token", undefined);
    storage.set("pending", undefined);
  }, [storage]);

  /** Liest einen Antwort-Stream in die Nachricht `key`; setzt bei Abbruch über die responseId fort. */
  const stream = useCallback(
    async (open: () => Promise<AsyncIterable<StreamEvent>>, key: string) => {
      let responseId: string | undefined;
      let lastId: string | undefined;
      let opener = open;
      for (let attempt = 0; ; attempt++) {
        try {
          for await (const event of await opener()) {
            if (event.id) lastId = event.id;
            switch (event.event) {
              case "started":
                responseId = event.data.responseId;
                storage.set("pending", { responseId } satisfies Pending);
                break;
              case "delta":
                update(key, (message) => ({ ...message, text: message.text + event.data.text }));
                break;
              case "done":
                storage.set("pending", undefined);
                update(key, (message) => ({ ...message, streaming: false }));
                if (event.data.status === "incomplete") setNotice({ message: bootstrap.texts.errors.incomplete });
                return;
              case "error":
                storage.set("pending", undefined);
                throw new ApiFailure(event.data, 200);
              case "signals":
                // reserviert für Workflow-Signale der Runtime (GA-Schritte), heute ungenutzt
                break;
            }
          }
          throw new StreamInterrupted("eof");
        } catch (error) {
          if (!(error instanceof StreamInterrupted) || attempt >= RESUME_ATTEMPTS - 1) throw error;
          await sleep(1000 * (attempt + 1));
          if (responseId) {
            const id = responseId;
            const after = lastId;
            opener = () => api.resume(tenant, token.current ?? "", id, after);
          }
          // ohne responseId: dieselbe Anfrage noch einmal; die Runtime spielt sie über die requestId ab 0 ab
          else update(key, (message) => ({ ...message, text: "" }));
        }
      }
    },
    [bootstrap, storage, tenant],
  );

  const run = useCallback(
    async (text: string, requestId: string) => {
      const key = nextKey();
      setMessages((list) => [...list, { key, role: "assistant", text: "", streaming: true }]);
      setNotice(null);
      setBusy(true);
      try {
        if (!token.current) {
          token.current = await api.createConversation(tenant, newRequestId(), currentTracking());
          storage.set("token", token.current);
        }
        const current = token.current;
        await stream(() => api.send(tenant, current, { requestId, text, tracking: currentTracking() }), key);
      } catch (error) {
        // leere Platzhalter-Nachricht entfernen, angefangene Antwort stehen lassen
        setMessages((list) =>
          list.flatMap((message) => (message.key !== key ? [message] : message.text ? [{ ...message, streaming: false }] : [])),
        );
        const errors = bootstrap.texts.errors;
        if (error instanceof ApiFailure && error.error.code === "session_invalid") {
          forgetConversation();
          setMessages([welcome()]);
          setNotice({
            message: errors.sessionExpired,
            retry: () => {
              setMessages((list) => [...list, { key: nextKey(), role: "user", text }]);
              void run(text, newRequestId());
            },
          });
        } else if (error instanceof ApiFailure) {
          const retryable = error.error.retryable;
          setNotice({
            message: error.error.message || errors.generic,
            retry: retryable ? () => void run(text, newRequestId()) : undefined,
          });
        } else {
          // Verbindung mehrfach abgebrochen: dieselbe requestId erneut senden (idempotent)
          setNotice({ message: errors.unavailable, retry: () => void run(text, requestId) });
        }
      } finally {
        setBusy(false);
      }
    },
    [bootstrap, currentTracking, forgetConversation, storage, stream, tenant, welcome],
  );

  const sendAgain = useCallback(
    (text: string) => {
      setMessages((list) => [...list, { key: nextKey(), role: "user", text }]);
      return run(text, newRequestId());
    },
    [run],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const current = token.current;
    if (!current) {
      setMessages([welcome()]);
      setBusy(false);
      return;
    }
    try {
      const history = await api.history(tenant, current);
      const restored: ChatMessage[] = history.map((message) => ({ key: nextKey(), role: message.role, text: message.text }));
      if (restored.length === 0) restored.push(welcome());
      setMessages(restored);
      const pending = storage.get<Pending>("pending");
      if (pending && restored.at(-1)?.role === "user") {
        // Seite wurde während einer Antwort neu geladen: Antwort von vorn abonnieren
        const key = nextKey();
        setMessages((list) => [...list, { key, role: "assistant", text: "", streaming: true }]);
        try {
          await stream(() => api.resume(tenant, current, pending.responseId, undefined), key);
        } catch {
          setMessages((list) => list.filter((message) => message.key !== key || message.text));
          storage.set("pending", undefined);
        }
      } else {
        storage.set("pending", undefined);
      }
    } catch (error) {
      if (error instanceof ApiFailure && (error.error.code === "session_invalid" || error.error.code === "not_found")) {
        forgetConversation();
        setMessages([welcome()]);
      } else {
        setMessages([welcome()]);
        setNotice({ message: bootstrap.texts.errors.unavailable, retry: () => void load() });
      }
    } finally {
      setBusy(false);
    }
  }, [bootstrap, forgetConversation, storage, stream, tenant, welcome]);

  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load();
  }, [load]);

  const send = useCallback(
    (text: string) => {
      if (busy || !text.trim()) return false;
      void sendAgain(text.trim());
      return true;
    },
    [busy, sendAgain],
  );

  return { messages, busy, notice, send };
}
