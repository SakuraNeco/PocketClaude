# PocketClaude

[繁體中文](README.md) · **English**

A self-hosted PWA to **remote-control and monitor the Claude Code sessions running on your computer**, from your phone or any browser. It drives your already-logged-in local `claude` CLI (so it uses your Max/Pro subscription — **no extra API cost**), reachable from anywhere through a Cloudflare tunnel.

- Watch every Claude Code conversation update live
- Send prompts to continue any recent session — or start a new one
- **Per-tool approval**: before Claude runs any tool, get a push notification and tap allow/deny
- **Run tasks in parallel** across different sessions; queue follow-ups on a busy one
- Key-based login (auto-generated on first launch)
- Clean Markdown rendering (DOMPurify-sanitized), syntax highlighting, image paste/attach
- View images / audio / video / PDFs Claude generates; open a local dev server on your phone via reverse proxy
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

- **One task per session** at a time; a second send to a busy session is queued and flushed when it finishes. Different sessions run in parallel.
- **You can't control PocketClaude's own session** from the web (it would restart and kill the server) — auto-blocked.
- Messages sent to a session **currently open live in Desktop** are written to the transcript but won't appear in that Desktop window until it's reopened.
- **No auto-restart**: closing the terminal / reboot / crash stops it. Use `pm2`, `launchd` (mac), Task Scheduler (win) to keep it alive.

## Security

- Everything except the PWA shell requires the login key (timing-safe compare; HttpOnly cookie).
- `/media` and `/files` are confined to your home directory (with path-boundary checks).
- Interactive approval is **fail-closed**: if the bridge can't reach the server, it denies.
- All Markdown output is DOMPurify-sanitized; text files (incl. HTML) are served as `text/plain`.
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
