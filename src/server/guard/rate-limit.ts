// Rate Limit im Speicher, festes Zeitfenster je Schlüssel. Gilt pro Instanz; für mehrere
// Instanzen kommt später Cloud Armor davor.
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Zählt einen Versuch; false, wenn das Limit im aktuellen Fenster schon erreicht ist. */
  hit(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (window.count >= limit) return false;
    window.count++;
    return true;
  }

  sweep() {
    const now = this.now();
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

/** Gespräche, in denen gerade eine Antwort läuft (mit der requestId, die sie gestartet hat). */
export class InflightRegistry {
  private readonly running = new Map<string, string>();

  /** true, wenn das Gespräch frei war oder dieselbe Anfrage wiederholt wird. */
  acquire(conversationId: string, requestId: string) {
    const current = this.running.get(conversationId);
    if (current !== undefined && current !== requestId) return false;
    this.running.set(conversationId, requestId);
    return true;
  }

  release(conversationId: string, requestId: string) {
    if (this.running.get(conversationId) === requestId) this.running.delete(conversationId);
  }
}
