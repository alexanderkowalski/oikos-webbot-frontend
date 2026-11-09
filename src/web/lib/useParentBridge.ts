import { useCallback, useEffect, useRef } from "react";
import type { Bootstrap, Tracking } from "../../shared/api";
import type { Storage } from "./storage";
import { buildGa4Event, mergeIncomingTracking, originOf, type TrackingStep } from "./tracking";

const inIframe = () => window.parent !== window;

/**
 * Verbindung zur Elternseite. Dieselbe Origin-Liste des Tenants gilt für eingehende
 * Nachrichten (event.origin + event.source) und für das targetOrigin ausgehender; nie "*".
 */
export function useParentBridge(bootstrap: Bootstrap, storage: Storage) {
  const tracking = useRef<Tracking>(storage.get<Tracking>("tracking") ?? {});
  const parentOrigin = useRef<string | null>(null);

  useEffect(() => {
    if (!inIframe()) return;
    const allowed = bootstrap.parentOrigins;
    const referrer = originOf(document.referrer);
    if (referrer && allowed.includes(referrer)) parentOrigin.current = referrer;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || !allowed.includes(event.origin)) return;
      parentOrigin.current = event.origin;
      const next = mergeIncomingTracking(tracking.current, event.data);
      if (!next) return;
      tracking.current = next;
      storage.set("tracking", next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bootstrap, storage]);

  const track = useCallback((step: TrackingStep, options: { interactionOption1?: string; linkUrl?: string } = {}) => {
    const target = parentOrigin.current;
    if (!inIframe() || !target) return;
    window.parent.postMessage(buildGa4Event({ step, ...options }, tracking.current), target);
  }, []);

  const currentTracking = useCallback(() => tracking.current, []);

  return { track, currentTracking };
}
