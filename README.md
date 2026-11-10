# oikos-webbot-frontend

Der Webchat für die Websites der Marken, Nachfolger von `oikos-bot-ui` und `oikos-bot-backend`. Das Repo enthält zwei Teile in einem Container:

- das **Chatfenster** (React), eingebettet als iframe unter `/iframe/:tenant`,
- einen kleinen **BFF** („Backend for Frontend“, Node + Hono), der die Gespräche über die Agent Runtime führt. Im Folgenden heißt dieser Server-Teil kurz BFF.

```text
Website (Elternseite) ──postMessage──> iframe /iframe/:tenant  (React)
                                          │  nur Webchat-API /wc/api/:tenant/…
                                          ▼
                                       BFF (Hono) ──Connect──> Agent Runtime (ResponsesService)
```

Die Runtime steuert das Gespräch (Workflows, Einwilligung, Lead-Erfassung). Das Chatfenster zeigt nur an und meldet GA-Schritte per postMessage an die Elternseite. Der Browser spricht nie direkt mit der Runtime; API-Key, Runtime-Tenant, Agent und Modellwerte kennt nur der BFF. Eine eigene Datenbank gibt es nicht.

## Lokal starten

Voraussetzung: Node 22.

| Dienst | Port |
|---|---|
| Chatfenster (Vite, `npm run dev`) | 5173 |
| Testseite als Elternseite (`npm run dev:parent`) | 5174 |
| BFF (`PORT`) | 8090 |
| Agent Runtime, lokaler Docker-Stack | 8080 |
| Agent Runtime, Stage über gcloud-Proxy | 8081 |

**1. Runtime bereitstellen**, eine der beiden Varianten:

- **Lokaler Docker-Stack** (empfohlen): in `../agent-runtime` laut dessen README starten (`docker compose up -d`), in der Console Tenant `hh` mit OpenAI-Key und einen Agenten mit aktiver Revision anlegen; seine ID muss zu `runtime.agentId` in `tenants/hh.json` passen (heute `webbot`). API-Key: `local-runtime-hh`. `WEBCHAT_RUNTIME_URL=http://localhost:8080`.
- **Stage**: braucht die Rolle „Cloud Run Invoker“ auf `agent-runtime-api-stage`.
  ```sh
  gcloud run services proxy agent-runtime-api-stage --region europe-west3 --port 8081
  ```
  `WEBCHAT_RUNTIME_URL=http://localhost:8081`, API-Key von Stage. Bis geklärt ist, ob Leadplus in Stage echt angebunden ist, Testgespräche nicht bis zum vollständigen Lead mit echten Daten führen.

**2. Chatfenster und BFF starten:**

```sh
npm install
cp .env.example .env          # WEBCHAT_SIGNING_SECRET, WEBCHAT_RUNTIME_URL und den API-Key eintragen
npm run dev                   # BFF auf :8090, Chatfenster über Vite auf :5173
```

- Chatfenster direkt: http://localhost:5173/iframe/hh
- Eingebettet wie auf der Website: `npm run dev:parent`, dann http://localhost:5174/?tenant=hh. Die Testseite schickt location/JourneyID/UserPseudoID an das iframe und zeigt die empfangenen `ga4Event`-Nachrichten an. Ihr Origin muss in `WEBCHAT_DEV_PARENT_ORIGINS` stehen.
- Wie im Container (mit CSP-Header): `npm run build && npm start`, dann http://localhost:8090/iframe/hh. `http://localhost:8090` steht dafür schon in `WEBCHAT_PUBLIC_ORIGINS` der `.env.example`.

Vite liest den BFF-Port aus `PORT` in der `.env`. Wer ihn ändert, muss auch `WEBCHAT_PUBLIC_ORIGINS` anpassen. Im Container setzt das Dockerfile `PORT=8080` (Vorgabe von Cloud Run).

Weitere Befehle: `npm test` (vitest), `npm run typecheck`, `npm run lint` (Biome: Lint, Formatierung, Import-Reihenfolge; so prüft auch die CI), `npm run format` (behebt, was Biome automatisch beheben kann), `npm run generate:rpc`. Die CI (`.github/workflows/ci.yaml`) führt bei jedem PR Lint, Typecheck, Tests, Build, `npm audit` und den Docker-Build aus; Dependabot schlägt wöchentlich Updates vor. Letzteres erzeugt den Runtime-Client neu aus `../agent-runtime/proto` (Branch `main`); das Ergebnis unter `src/server/gen` ist eingecheckt. Aktueller Stand: erzeugt aus `agent-runtime` Commit `d0aa7f8` (letzte Änderung an `proto/`, 23.10.2026).

## Konfiguration

### Umgebung (`.env`)

| Variable | Bedeutung |
|---|---|
| `PORT` | Port des BFF (Standard 8090; im Container 8080) |
| `WEBCHAT_PUBLIC_ORIGINS` | Eigene Adresse(n) des Chatfensters. Die Webchat-API nimmt nur Anfragen mit diesem `Origin` an. |
| `WEBCHAT_RUNTIME_URL` | Basis-URL der Runtime: lokaler Docker-Stack `http://localhost:8080`, Stage über Proxy `http://localhost:8081` |
| `WEBCHAT_RUNTIME_AUTH` | `none` (Standard, lokal) oder `google-id-token`: Der BFF holt auf Cloud Run ein ID-Token vom Metadata-Server und sendet es als `Authorization: Bearer …`. Pflicht, wenn die Runtime IAM verlangt; das Dienstkonto des BFF braucht dann die Rolle „Cloud Run Invoker“ auf der Runtime. |
| `WEBCHAT_RUNTIME_AUDIENCE` | Nur mit `google-id-token`: Audience des Tokens. Standard ist der Origin von `WEBCHAT_RUNTIME_URL`; bei eigener Domain die run.app-URL der Runtime eintragen. |
| `WEBCHAT_SIGNING_SECRET` | Schlüssel für die Conversation-Tokens, z. B. `openssl rand -base64 32`. Ein neuer Wert macht alle offenen Gespräche im Browser ungültig. |
| `WEBCHAT_TRUSTED_PROXY_COUNT` | Anzahl vertrauenswürdiger Proxies vor dem BFF, siehe [Client-IP](#client-ip) |
| `WEBCHAT_DEV_PARENT_ORIGINS` | Nur lokal: zusätzliche Eltern-Origins für alle Tenants (Testseite). Mit `NODE_ENV=production` (so im Dockerfile) startet der Server nicht, wenn sie gesetzt ist. |
| `WEBCHAT_RUNTIME_API_KEY_<…>` | API-Key je Tenant; der Name steht in der Tenant-Datei unter `runtime.apiKeyEnv` |

### Tenants (`tenants/<slug>.json`)

Alles Tenant-Spezifische steht in einer Datei je Slug; der Dateiname ist der Slug in `/iframe/:tenant` und `/wc/api/:tenant`. Der BFF prüft alle Dateien beim Start und bricht mit einer klaren Meldung ab, wenn etwas fehlt.

| Feld | Inhalt |
|---|---|
| `runtime` | `tenantId` und `agentId` der Runtime, `apiKeyEnv` = Name der Umgebungsvariable mit dem API-Key |
| `model` | `name`, `reasoningEffort` (`NONE` … `MAX`), `maxOutputTokens`. Pflicht, kein Standard. |
| `parentOrigins` | Origins der Website(s), auf denen das iframe laufen darf. Dieselbe Liste gilt für `frame-ancestors`, für eingehende postMessages (`event.origin` + `event.source === window.parent`) und als `targetOrigin` ausgehender postMessages. |
| `limits` | Zeichen je Nachricht, Rate Limits je IP und Gespräch, neue Gespräche je IP und Stunde. Eine Obergrenze für Nachrichten je Gespräch gibt es nicht (wie im alten Bot); lange Verläufe kürzt die Runtime selbst. |
| `presentation` | Name, Untertitel, Avatar, Farben, Willkommensnachricht, Disclaimer, Platzhalter, Sprache |
| `consentButtons` | Button-Texte, die als Einwilligung bzw. Ablehnung zählen (GA-Schritt `data_policy`) |
| `referrerHosts` | Hosts, an die Links den Referrer weitergeben (eigene Seiten) |
| `texts` | Beschriftungen und Fehlermeldungen; `{max}` wird durch die Zeichengrenze ersetzt |

**Neuen Tenant hinzufügen:** `tenants/<slug>.json` anlegen (Vorlage: `hh.json`, Unterschiede der Marken siehe `oikos-bot-backend/config/tenant-profiles/web.json`), API-Key als Secret unter dem Namen aus `runtime.apiKeyEnv` setzen. Kein Code-Umbau nötig.

## Webchat-API

Alle Routen unter `/wc/api/:tenant`. Die Routen unter `/conversation/…` verlangen den Header `X-Conversation-Token` mit dem vom BFF signierten Conversation-Token (`v1.<payload>.<hmac>`, enthält Tenant und Gesprächs-ID). Das Token steht bewusst nie in der URL, weil Cloud Run und Load Balancer URLs in ihre Zugriffslogs schreiben. Fehler kommen als `{ "error": { code, message, retryable } }`; `message` ist für Nutzer formuliert.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/bootstrap` | Darstellung, Texte, Eltern-Origins, Zeichengrenze. Keine Runtime-Werte. |
| POST | `/conversations` | `{ requestId, tracking }` → `{ token }`. Legt das Gespräch erst beim ersten Senden an, mit der Willkommensnachricht als Startnachricht des Assistenten und den Tracking-Daten als Metadaten. |
| POST | `/conversation/messages` | `{ requestId, text, tracking }` → SSE-Stream der Antwort |
| GET | `/conversation/responses/:responseId/events?after=n` | Stream nach Abbruch ab Sequenz `n` fortsetzen |
| GET | `/conversation/messages` | Verlauf zum Neuladen der Seite (nur Nutzer- und Antworttexte) |

SSE-Ereignisse (`id` = Sequenznummer der Runtime): `started { responseId }`, `delta { text }`, `done { status: completed | incomplete | cancelled }`, `error { code, message, retryable }`. `signals` ist reserviert für erledigte Workflows, sobald die Runtime sie über die Chat-API liefert; heute wird es nie gesendet.

Vor jeder Nachricht prüft der BFF: Origin, Token, Länge, Rate Limit je IP und je Gespräch, und ob im Gespräch schon eine Antwort läuft. Außerdem übernimmt er geänderte Tracking-Daten in die Metadaten (`RetrieveConversation`, bei Änderung `UpdateConversation` mit dem vollständigen Stand).

Metadaten: `channel=webchat`, `entry_page` und `journey_id` (nur einmal gesetzt), `origin_info` und `user_pseudo_id` (folgen dem neuesten Wert), Werte auf 512 Zeichen gekürzt, höchstens 16 Einträge.

### Client-IP

`WEBCHAT_TRUSTED_PROXY_COUNT = N`: Die Client-IP ist der N-te Eintrag von rechts in `X-Forwarded-For`, also der, den der äußerste vertrauenswürdige Proxy angehängt hat. Alles links davon kann der Client selbst gesetzt haben. Beispiel Google Cloud Load Balancer vor Cloud Run: Der Load Balancer hängt `<client-ip>, <lb-ip>` an, also `N = 2`. Vor dem Deployment am echten Header prüfen.

## Health-Check

`GET /health` liefert `{"status":"ok"}`. Bewusst nicht `/healthz`: Auf `*.run.app` fängt das Google Frontend solche Pfade ab, bevor sie den Container erreichen.

## Logs

Eine JSON-Zeile je Ereignis (Cloud Logging). Geloggt werden Tenant, Gesprächs- und Response-ID, Status, Fehlercodes, Token-Verbrauch (`inputTokens`, `outputTokens`, `reasoningTokens`; `maxOutputTokens` gilt für die Summe aller Modellaufrufe einer Response inklusive Reasoning) und Zeiten, insbesondere `firstTokenMs` (Zeit bis zum ersten Wort) und `totalMs` im Ereignis `response`. Nie Nachrichteninhalte, Tracking-Werte oder IP-Adressen.

## Chatfenster

- Willkommensnachricht sofort aus dem Bootstrap, ohne Runtime-Aufruf.
- Links in beiden Schreibweisen: `{{Text}}(url)` und `[Text](url)`. `[Text]` ohne folgende `(url)` wird zum Button (untereinander); ein Klick sendet den Text als normale Nachricht. Buttons sind nur an der letzten Antwort aktiv.
- GA-Schritte per postMessage (`ga4Event`, Format wie im alten bot-ui): `send_message`, `select_topic`, `data_policy` (Einwilligungs-Buttons laut `consentButtons`), `link_click`. `open_close_chatbot` meldet die Website selbst.
- localStorage unter `webchat:<slug>:*` (Token, laufende Antwort, Tracking-Stand, Hell/Dunkel).
- Nicht in Version 1: Feedback, Erinnerung nach 3 Minuten, „Session neu starten“, PDF-Download.
