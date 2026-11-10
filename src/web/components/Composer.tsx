import { type FormEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

type Props = {
  placeholder: string;
  sendLabel: string;
  maxLength: number;
  tooLong: string;
  busy: boolean;
  onSend: (text: string) => boolean;
};

const MAX_HEIGHT = 200;

export function Composer({ placeholder, sendLabel, maxLength, tooLong, busy, onSend }: Props) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const length = Array.from(text).length;
  const overLimit = length > maxLength;
  const canSend = !busy && text.trim() !== "" && !overLimit;

  // biome-ignore lint/correctness/useExhaustiveDependencies: text löst die Höhenanpassung bewusst nur aus
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSend && onSend(text)) setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={overLimit || undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-11 flex-1 resize-none overflow-y-auto rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label={sendLabel}
          title={sendLabel}
          className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary text-user-text transition-opacity disabled:opacity-50"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.03.94l7.93 3.18a2 2 0 0 1 1.11 1.11z" />
            <path d="m21.85 2.15-10.94 10.94" />
          </svg>
        </button>
      </div>
      {overLimit && (
        <p role="alert" className="text-xs text-secondary">
          {tooLong}
        </p>
      )}
    </form>
  );
}
