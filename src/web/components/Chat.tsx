import { useCallback, useEffect, useRef } from "react";
import type { Bootstrap } from "../../shared/api";
import type { Storage } from "../lib/storage";
import { TRACKING_STEPS } from "../lib/tracking";
import { useChat } from "../lib/useChat";
import { useParentBridge } from "../lib/useParentBridge";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { Message } from "./Message";

export function Chat({ bootstrap, storage }: { bootstrap: Bootstrap; storage: Storage }) {
  const { track, currentTracking } = useParentBridge(bootstrap, storage);
  const { messages, busy, notice, send } = useChat(bootstrap, storage, currentTracking);
  const { presentation, texts, consentButtons } = bootstrap;

  const sendTyped = useCallback(
    (text: string) => {
      const sent = send(text);
      if (sent) track(TRACKING_STEPS.sendMessage);
      return sent;
    },
    [send, track],
  );

  const sendButton = useCallback(
    (label: string) => {
      if (!send(label)) return;
      if (consentButtons.accepted.includes(label)) {
        track(TRACKING_STEPS.dataPolicy, { interactionOption1: "datapolicy_accepted" });
      } else if (consentButtons.denied.includes(label)) {
        track(TRACKING_STEPS.dataPolicy, { interactionOption1: "datapolicy_denied" });
      } else {
        track(TRACKING_STEPS.selectTopic, { interactionOption1: label });
      }
    },
    [consentButtons, send, track],
  );

  const onLinkClick = useCallback((href: string) => track(TRACKING_STEPS.linkClick, { linkUrl: href }), [track]);

  // Mitscrollen, solange der Nutzer unten ist
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages und notice lösen das Scrollen bewusst nur aus
  useEffect(() => {
    const element = list.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [messages, notice]);
  const onScroll = () => {
    const element = list.current;
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  };

  const last = messages.at(-1);
  return (
    <div className="flex h-full flex-col">
      <Header bootstrap={bootstrap} storage={storage} />
      <div ref={list} onScroll={onScroll} className="flex-1 overflow-y-auto" aria-live="polite">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
          {messages.map((message) => (
            <Message
              key={message.key}
              message={message}
              avatarUrl={presentation.avatarUrl}
              typingLabel={texts.typing}
              referrerHosts={bootstrap.referrerHosts}
              buttonsActive={!busy && message === last}
              onButton={sendButton}
              onLinkClick={onLinkClick}
            />
          ))}
          {notice && (
            <div role="alert" className="fade-in flex flex-col items-center gap-2 py-1 text-center text-sm text-muted">
              <p>{notice.message}</p>
              {notice.retry && (
                <button
                  type="button"
                  onClick={notice.retry}
                  className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink hover:border-primary"
                >
                  {texts.retry}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <footer className="shrink-0 border-t border-line bg-surface px-4 pt-3 pb-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-1">
          <Composer
            placeholder={presentation.messagePlaceholder}
            sendLabel={texts.send}
            maxLength={bootstrap.maxMessageLength}
            tooLong={texts.errors.messageTooLong.replace("{max}", String(bootstrap.maxMessageLength))}
            busy={busy}
            onSend={sendTyped}
          />
          {presentation.disclaimer && <p className="text-[10px] leading-snug text-muted">{presentation.disclaimer}</p>}
        </div>
      </footer>
    </div>
  );
}
