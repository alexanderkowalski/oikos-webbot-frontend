import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Bootstrap } from "../shared/api";
import { Chat } from "./components/Chat";
import { api } from "./lib/api";
import { createStorage } from "./lib/storage";

export function App({ tenant }: { tenant: string }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!tenant) {
      setFailed(true);
      return;
    }
    api.bootstrap(tenant).then(setBootstrap, () => setFailed(true));
  }, [tenant]);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">
        Der Chat ist gerade nicht verfügbar. Bitte versuchen Sie es später noch einmal.
      </div>
    );
  }
  if (!bootstrap) return <div className="h-full" aria-busy="true" />;
  return <Loaded bootstrap={bootstrap} />;
}

function Loaded({ bootstrap }: { bootstrap: Bootstrap }) {
  const storage = useMemo(() => createStorage(bootstrap.tenant), [bootstrap.tenant]);
  const { colors, language, assistantName } = bootstrap.presentation;

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = assistantName;
  }, [language, assistantName]);

  const style = {
    "--wc-primary": colors.primary,
    "--wc-secondary": colors.secondary,
    "--wc-header-text": colors.headerText,
    "--wc-subtitle-text": colors.subtitleText,
    "--wc-user-text": colors.userMessageText,
    "--wc-assistant-link": colors.assistantLink,
  } as CSSProperties;

  return (
    <div className="h-full" style={style}>
      <Chat bootstrap={bootstrap} storage={storage} />
    </div>
  );
}
