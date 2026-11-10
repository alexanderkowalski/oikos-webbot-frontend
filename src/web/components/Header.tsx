import { useEffect, useState } from "react";
import type { Bootstrap } from "../../shared/api";
import type { Storage } from "../lib/storage";

type Theme = "light" | "dark";

function initialTheme(storage: Storage): Theme {
  const stored = storage.get<Theme>("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function Header({ bootstrap, storage }: { bootstrap: Bootstrap; storage: Storage }) {
  const { presentation, texts } = bootstrap;
  const [theme, setTheme] = useState<Theme>(() => initialTheme(storage));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    storage.set("theme", next);
  };

  return (
    <header className="shrink-0 border-b-3 border-secondary bg-primary text-header-text">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {presentation.avatarUrl && (
            <div className="relative size-10 shrink-0">
              <img src={presentation.avatarUrl} alt="" className="size-10 rounded-full ring-2 ring-secondary" />
              <span className="absolute right-0 bottom-0 block size-2.5 rounded-full border-2 border-primary bg-lime-500" />
            </div>
          )}
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{presentation.assistantName}</span>
            <span className="truncate text-sm text-subtitle-text">{presentation.subtitle}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-label={texts.toggleTheme}
          title={texts.toggleTheme}
          className="rounded-md p-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
        >
          {theme === "light" ? <MoonIcon /> : <SunIcon />}
        </button>
      </div>
    </header>
  );
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const MoonIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);

const SunIcon = () => (
  <svg {...iconProps} aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);
