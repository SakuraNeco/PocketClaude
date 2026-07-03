# PocketClaude

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · **English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

A self-hosted PWA to **remote-control and monitor the Claude Code sessions running on your computer**, from your phone or any browser. It drives your already-logged-in local `claude` CLI (so it uses your Max/Pro subscription — **no extra API cost**), reachable from anywhere through a Cloudflare tunnel.

- Watch every Claude Code conversation update live
- Send prompts to continue any recent session — or start a new one
- **Per-tool approval**: before Claude runs any tool, get a push notification and tap allow/deny
- **Live token-by-token streaming + mid-task follow-ups**: replies stream as Claude writes them; message a running session and it feeds the live process (runs next turn, no cold start); sessions run in parallel
- Key-based login (auto-generated on first launch)
- Clean Markdown rendering (DOMPurify-sanitized), syntax highlighting, image paste/attach
- View images / audio / video / PDFs Claude generates; open a local dev server on your phone via reverse proxy; **static HTML prototypes render directly on the phone** (sandboxed, no need to spin up your own server)
- **Tools panel**: usage/cost stats · output media gallery · one-tap switching between multiple servers
- Sessions can be **pinned / archived** — easy to find even when the list gets long
- Built-in file browser + styled Markdown reader
- **8 UI languages**, light/dark themes, adjustable thinking effort, voice input
- Installable as an app, push notifications on task completion — localized per device
- Works offline / behind a firewall (all assets self-hosted)

> ⚠️ **It controls the machine it runs on.** Run it on computer A and it controls A's Claude only. It reads the local `~/.claude` and invokes the local `claude` CLI.

---

## Requirements

- **Node.js 18+**
- **Claude Code / Claude Desktop installed and logged in** (Max or Pro subscription) — if `claude` runs in your terminal, you're set
- (for remote access) **cloudflared** — no install needed, run via `npx` below

Runs on **Windows / macOS / Linux** (CLI path and app-data dirs are auto-detected per OS).

## Install

```bash
git clone https://github.com/SakuraNeco/PocketClaude.git
cd PocketClaude
npm install
```

## Run

```bash
npm start
```

You'll see:

```
PocketClaude server → http://localhost:3000
login key:   xxxxxxxxxxxxxxxxxxxxxxxx
claude CLI:  /path/to/claude
```

Open <http://localhost:3000> and enter the **login key** from the startup log (once per device).

> The key is stored in `.auth-token` (gitignored) — delete it and restart for a fresh one, or set `CC_AUTH_TOKEN`. If the `claude CLI` line is wrong, copy `.env.example` to `.env` and point `CLAUDE_PATH` at your `claude`.

## Access from your phone (Cloudflare tunnel)

```bash
npm run tunnel
```

Prints a `https://xxxx.trycloudflare.com` URL — open it on your phone, enter the login key. For a stable URL, use a Cloudflare [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) pointing at `http://localhost:3000`.

> ⚠️ **Using your own domain (named tunnel)?** Cloudflare managed WAF rules 403 paths like `/node_modules/…`, breaking `/proxy` previews of Vite dev servers. Add a custom rule in the Cloudflare dashboard: Hostname equals your subdomain → action **Skip** (check all managed rules + all remaining custom rules). PocketClaude has its own key auth and does not rely on the WAF.

## Install as an app + push

1. Open the https URL in your phone browser
2. Add to Home Screen
3. Open from the home-screen icon, tap **Enable notifications**
   - iOS web push only works after Add-to-Home-Screen

---

## Usage

- Pick the conversation to control from the top **Send to** selector, type, and send.
- **Permission modes**:
  | Mode | Behaviour |
  |------|-----------|
  | Approve each `interactive` | Every tool call is pushed to your phone; you allow/deny (auto-deny after 120 s) |
  | Auto-edit `acceptEdits` (default) | File edits auto-approved |
  | Full auto `bypassPermissions` | Everything allowed — most capable, least guarded |
  | Plan `plan` | Plan only, no changes |
- **Model**: Default / Fable 5 / Opus / Sonnet / Haiku · **Effort**: Default / Low / Medium / High / X-High / Max

### Notes / limitations

- **Persistent streaming sessions**: replies render token-by-token; a send to a busy session is streamed into the live process (runs after the current turn — no cold start), so you can add instructions or ask follow-ups without a restart. Sessions run in parallel; each process exits after 5 min idle.
- The sidebar **Files** button browses the session directory (`.md` opens in the built-in reader), and `.html` **renders as a web page** on the phone (sandboxed).
- Top-right **⊞ Tools**: **Usage** (how much each project cost — only counts turns sent through PocketClaude), **Gallery** (a wall of every image/audio/video generated across sessions), **Servers** (save multiple PocketClaude machines and switch with one tap, carrying the key).
- Session rows can be **pinned** (to the top) or **archived** (sink to the bottom + dimmed); these settings are stored locally in the browser.
- **You can't control PocketClaude's own session** from the web (it would restart and kill the server) — auto-blocked.
- Messages sent to a session **currently open live in Desktop** are written to the transcript but won't appear in that Desktop window until it's reopened.
- **No auto-restart**: closing the terminal / reboot / crash stops it. Use `pm2`, `launchd` (mac), Task Scheduler (win) to keep it alive.

## Security

- Everything except the PWA shell requires the login key (timing-safe compare; HttpOnly cookie).
- `/media` and `/files` are confined to your home directory (with path-boundary checks).
- Interactive approval is **fail-closed**: if the bridge can't reach the server, it denies.
- All Markdown output is DOMPurify-sanitized; `/media` serves text files (incl. HTML) as `text/plain`. To preview a `.html` file as a real page, `/html` renders it under a **`sandbox` CSP** (opaque origin): its own JS runs, but it can't touch the auth cookie or reach same-origin APIs.
- `/proxy` only reaches ports referenced by a session (override with `CC_PROXY_ALLOW`).
- `/auth` throttles brute force; sessions under the OS temp dir are hidden.
- `.audit.log` records auth attempts, sends, stops, and permission decisions.

## Environment variables (all optional — see `.env.example`)

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default 3000) |
| `CLAUDE_PATH` | Path to the `claude` CLI (auto-detected if unset) |
| `CC_AUTH_TOKEN` | Login key (auto-generated into `.auth-token` if unset) |
| `CC_PROXY_ALLOW` | Comma-separated extra ports `/proxy` may reach |
| `VAPID_SUBJECT` | Web Push contact `mailto:` |

VAPID keys, login key, push subscriptions and uploads are generated **per install** and gitignored.

## Development

```bash
npm test        # node --test — unit tests for the pure helpers
node --check server.js
```

CI runs syntax checks + tests on Node 18/20/22.

## License

MIT
