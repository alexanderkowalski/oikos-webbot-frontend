// localStorage mit eigenem Präfix je Tenant (webchat:<slug>:<key>), getrennt vom alten Chat
// (webbot:*). Fehler (privater Modus, blockierte Website-Daten) werden geschluckt.
export function createStorage(tenant: string) {
  const key = (name: string) => `webchat:${tenant}:${name}`;
  return {
    get<T>(name: string): T | undefined {
      try {
        const raw = window.localStorage.getItem(key(name));
        return raw === null ? undefined : (JSON.parse(raw) as T);
      } catch {
        return undefined;
      }
    },
    set(name: string, value: unknown) {
      try {
        if (value === undefined) window.localStorage.removeItem(key(name));
        else window.localStorage.setItem(key(name), JSON.stringify(value));
      } catch {
        // ohne Speicher läuft das Gespräch trotzdem, nur nicht über ein Neuladen hinweg
      }
    },
  };
}
export type Storage = ReturnType<typeof createStorage>;
