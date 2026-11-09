import { memo, type MouseEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { parseMessage } from "../lib/markup";
import type { ChatMessage } from "../lib/useChat";

type Props = {
  message: ChatMessage;
  avatarUrl: string | null;
  typingLabel: string;
  referrerHosts: string[];
  buttonsActive: boolean;
  onButton: (label: string) => void;
  onLinkClick: (href: string) => void;
};

const plugins = [remarkGfm, remarkBreaks];

function linkComponents(referrerHosts: string[]): Components {
  return {
    a: ({ href, children }) => {
      let rel = "noopener noreferrer";
      try {
        // Eigene Seiten des Tenants dürfen den Referrer sehen (wie im alten Chatfenster).
        if (href && referrerHosts.includes(new URL(href).hostname)) rel = "noopener";
      } catch {
        // relative oder ungültige URL: Standard behalten
      }
      return (
        <a href={href} target="_blank" rel={rel}>
          {children}
        </a>
      );
    },
  };
}

export const Message = memo(function Message(props: Props) {
  const { message, avatarUrl, typingLabel, referrerHosts, buttonsActive, onButton, onLinkClick } = props;

  if (message.role === "user") {
    return (
      <div className="fade-in flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-none bg-primary px-4 py-2 text-sm whitespace-pre-wrap text-user-text [overflow-wrap:anywhere]">
          {message.text}
        </div>
      </div>
    );
  }

  const { markdown, buttons } = parseMessage(message.text, message.streaming);
  const handleClick = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest("a");
    if (anchor instanceof HTMLAnchorElement) onLinkClick(anchor.href);
  };

  return (
    <div className="fade-in flex items-start gap-3">
      {avatarUrl && <img src={avatarUrl} alt="" className="size-10 shrink-0 rounded-full" />}
      <div className="flex max-w-[80%] flex-col gap-2 rounded-2xl rounded-tl-none border border-line bg-surface px-4 py-2 shadow-xs">
        {markdown ? (
          <div className="chat-markdown" onClick={handleClick}>
            <Markdown remarkPlugins={plugins} components={linkComponents(referrerHosts)}>
              {markdown}
            </Markdown>
          </div>
        ) : (
          message.streaming && (
            <div className="flex items-center justify-center gap-1 py-1" role="status" aria-label={typingLabel}>
              <span aria-hidden="true" className="typing-dot size-2 rounded-full bg-muted" />
              <span aria-hidden="true" className="typing-dot size-2 rounded-full bg-muted" />
              <span aria-hidden="true" className="typing-dot size-2 rounded-full bg-muted" />
            </div>
          )
        )}
        {!message.streaming && buttons.length > 0 && (
          <div className="flex flex-col items-start gap-2">
            {buttons.map((label, index) => (
              <button
                key={`${index}-${label}`}
                type="button"
                disabled={!buttonsActive}
                onClick={() => onButton(label)}
                className="rounded-md border border-line bg-surface px-3 py-1.5 text-left text-xs text-ink transition-colors enabled:hover:border-primary enabled:hover:text-primary disabled:cursor-default disabled:opacity-60"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
