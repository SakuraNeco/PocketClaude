# PocketClaude

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch**

Eine selbst gehostete PWA, um **die Claude-Code-Sitzungen auf deinem Rechner vom Handy oder jedem Browser aus fernzusteuern und zu überwachen**. Sie nutzt dein bereits angemeldetes lokales `claude`-CLI (läuft über dein Max/Pro-Abo — **keine zusätzlichen API-Kosten**), erreichbar von überall über einen Cloudflare-Tunnel.

- Alle Claude-Code-Unterhaltungen live verfolgen
- Prompts senden, um jede Sitzung fortzusetzen — oder eine neue zu starten
- **Einzelbestätigung**: Bevor Claude ein Werkzeug ausführt, kommt eine Push-Benachrichtigung — erlauben/ablehnen per Tipp
- **Parallele Aufgaben** über verschiedene Sitzungen; Nachrichten an eine beschäftigte Sitzung landen in der Warteschlange
- Schlüssel-Login (beim ersten Start automatisch generiert)
- Sauberes Markdown-Rendering (DOMPurify-bereinigt), Syntax-Highlighting, Bilder einfügen/anhängen
- Von Claude erzeugte Bilder / Audio / Videos / PDFs ansehen; Dev-Server auf dem Handy voranschauen
- Eingebauter Dateibrowser + Markdown-Reader
- **8 UI-Sprachen**, helle/dunkle Themes, einstellbarer Denk-Aufwand, Spracheingabe
- Als App installierbar, Push-Benachrichtigungen bei Aufgabenende — pro Gerät lokalisiert
- Funktioniert offline / hinter einer Firewall (alle Assets selbst gehostet)

> ⚠️ **Sie steuert die Maschine, auf der sie läuft.** Auf Rechner A gestartet, steuert sie nur As Claude. Sie liest das lokale `~/.claude` und ruft das lokale `claude`-CLI auf.

---

## Voraussetzungen

- **Node.js 18+**
- **Claude Code / Claude Desktop installiert und angemeldet** (Max- oder Pro-Abo) — wenn `claude` im Terminal läuft, passt es
- (für Fernzugriff) **cloudflared** — keine Installation nötig, läuft über `npx`

Läuft unter **Windows / macOS / Linux** (CLI-Pfad und Datenverzeichnisse werden automatisch erkannt).

## Installation

```bash
git clone https://github.com/SakuraNeco/PocketClaude.git
cd PocketClaude
npm install
```

## Starten

```bash
npm start
```

Du siehst:

```
PocketClaude server → http://localhost:3000
login key:   xxxxxxxxxxxxxxxxxxxxxxxx
claude CLI:  /path/to/claude
```

Öffne <http://localhost:3000> und gib den **login key** aus dem Startlog ein (einmal pro Gerät).

> Der Schlüssel liegt in `.auth-token` (gitignored) — löschen und neu starten erzeugt einen neuen, oder setze `CC_AUTH_TOKEN`. Stimmt die `claude CLI`-Zeile nicht, kopiere `.env.example` nach `.env` und setze `CLAUDE_PATH`.

## Zugriff vom Handy (Cloudflare-Tunnel)

```bash
npm run tunnel
```

Gibt eine `https://xxxx.trycloudflare.com`-URL aus — am Handy öffnen, Schlüssel eingeben. Für eine feste URL nutze einen Cloudflare-[Named Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), der auf `http://localhost:3000` zeigt.

> ⚠️ **Eigene Domain (Named Tunnel)?** Cloudflares verwaltete WAF-Regeln blocken Pfade wie `/node_modules/…` mit 403 und zerstören damit `/proxy`-Vorschauen von Vite-Dev-Servern. Lege im Cloudflare-Dashboard eine eigene Regel an: Hostname gleich deiner Subdomain → Aktion **Skip** (alle verwalteten Regeln + alle verbleibenden eigenen Regeln anhaken). PocketClaude hat eine eigene Schlüssel-Authentifizierung und ist nicht auf die WAF angewiesen.

## Als App installieren + Push

1. Die https-URL im Handy-Browser öffnen
2. Zum Home-Bildschirm hinzufügen
3. Über das Icon öffnen und **Benachrichtigungen aktivieren** antippen (iOS-Web-Push funktioniert nur nach dem Hinzufügen zum Home-Bildschirm)

---

## Bedienung

- Oben unter **Senden an** die Unterhaltung wählen, tippen, senden.
- **Berechtigungsmodi**:
  | Modus | Verhalten |
  |------|-----------|
  | Einzeln bestätigen `interactive` | Jeder Werkzeugaufruf wird aufs Handy gepusht; erlauben/ablehnen (Auto-Ablehnung nach 120 s) |
  | Auto-Bearbeiten `acceptEdits` (Standard) | Dateiänderungen automatisch erlaubt |
  | Vollautomatisch `bypassPermissions` | Alles erlaubt — am fähigsten, am wenigsten geschützt |
  | Planmodus `plan` | Nur planen, keine Änderungen |
- **Modell**: Standard / Fable 5 / Opus / Sonnet / Haiku · **Aufwand**: Standard / Niedrig / Mittel / Hoch / Sehr hoch / Max
- Oben rechts: **Sprache** (8) und **Theme**. Neben dem Eingabefeld: **Spracheingabe**.
- Der **Dateien**-Button in der Seitenleiste durchsucht den Sitzungsordner; `.md` öffnet im eingebauten Reader.

### Hinweise / bekannte Grenzen

- **Eine Aufgabe pro Sitzung** gleichzeitig; eine zweite Nachricht an eine beschäftigte Sitzung wird eingereiht und nach Abschluss gesendet. Verschiedene Sitzungen laufen parallel.
- **PocketClaudes eigene Sitzung ist über das Web nicht steuerbar** (würde den Server neu starten und töten) — automatisch blockiert.
- Nachrichten an eine **im Desktop geöffnete** Unterhaltung landen in der Datei, erscheinen in dem Fenster aber erst nach dem Neuöffnen.
- **Kein Auto-Neustart**: Terminal schließen / Reboot / Absturz stoppt den Server. Nutze `pm2`, `launchd` (mac) oder die Aufgabenplanung (win).

## Sicherheit

- Alles außer der PWA-Hülle erfordert den Schlüssel (timing-sicherer Vergleich; HttpOnly-Cookie).
- `/media` und `/files` sind auf dein Home-Verzeichnis beschränkt (mit Pfadgrenzen-Prüfung).
- Die interaktive Bestätigung ist **fail-closed**: Erreicht die Brücke den Server nicht, wird abgelehnt.
- Alles Markdown wird mit DOMPurify bereinigt; Textdateien (inkl. HTML) werden als `text/plain` ausgeliefert.
- `/proxy` erreicht nur Ports, die in einer Sitzung vorkamen (erweiterbar über `CC_PROXY_ALLOW`).
- `/auth` drosselt Brute-Force; Sitzungen im OS-Temp-Verzeichnis werden ausgeblendet.
- `.audit.log` protokolliert Anmeldungen, Sendungen, Stopps und Berechtigungsentscheidungen.

## Umgebungsvariablen (alle optional — siehe `.env.example`)

| Variable | Beschreibung |
|----------|-------------|
| `PORT` | Server-Port (Standard 3000) |
| `CLAUDE_PATH` | Pfad zum `claude`-CLI (sonst automatisch erkannt) |
| `CC_AUTH_TOKEN` | Login-Schlüssel (sonst automatisch in `.auth-token` erzeugt) |
| `CC_PROXY_ALLOW` | Zusätzliche für `/proxy` erlaubte Ports (kommagetrennt) |
| `VAPID_SUBJECT` | Web-Push-Kontakt `mailto:` |

VAPID-Schlüssel, Login-Schlüssel, Push-Abos und Uploads werden **pro Installation** erzeugt und sind gitignored.

## Entwicklung

```bash
npm test        # node --test — Unit-Tests der reinen Funktionen
node --check server.js
```

Die CI führt Syntaxprüfung + Tests auf Node 18/20/22 aus.

## Lizenz

MIT
