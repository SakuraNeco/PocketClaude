# PocketClaude

A self-hosted PWA to **remote-control and monitor Claude Code sessions** from a phone/browser, using the Max subscription via the local `claude` CLI (no API cost). Runs on the user's own machine; reach it remotely over a Cloudflare tunnel.

## Run

```bash
npm start                 # node server.js → http://localhost:3000
npm run tunnel            # quick tunnel: npx cloudflared tunnel --url http://localhost:3000
```

For a stable URL, use a Cloudflare named tunnel pointing at `http://localhost:3000` (machine-specific setup goes in `CLAUDE.local.md`, not here).

The server is a **plain process with no supervisor** — it dies on terminal close / reboot / crash and does NOT auto-restart. Start it detached if you want it to outlive a shell.

## Architecture (two files do everything)

- **`server.js`** — Express + `ws` (WebSocket) + `web-push` (VAPID) + `multer`. Discovers sessions, tails their JSONL transcripts, broadcasts events over WS, and spawns `claude --resume … --print` on send.
- **`public/index.html`** — single-file PWA (WS client, `marked` + `highlight.js`, session picker/bottom-sheet, image paste/attach, iOS-keyboard handling, permission selector, "傳送至" target indicator). `sw.js` = push + passthrough fetch (no caching). `manifest.json`, `icon.svg`.

## Session model (the core, non-obvious part)

Three kinds of sessions are discovered and tailed into `tailedSessions` (keyed by the CLI session id):

1. **Desktop** (`source:'desktop'`): scanned from `~/.claude/sessions/*.json` (live pid markers; removed when the window closes). Transcript: `~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl`. **Resumable** via the web. Retired by `scanSessions` when the window closes.
2. **Code history** (`source:'code'`): the most-recent session per project under `~/.claude/projects/*`, so the web can resume any recent project — not just open windows. Tailed with a 256 KB tail cap; the real cwd is read from the transcript tail (`readCwdFromTranscript`) since the escaped dir name is lossy. NOT retired by the Desktop cleanup loop, but IS retired by `scanCodeHistory` itself when a newer session replaces it as the project's most-recent (prevents unbounded tail/poll/history accumulation). Skipped if already live as a Desktop session.
3. **Cowork** (`source:'cowork'`, a.k.a. "local agent mode"): scanned from `%APPDATA%/Claude/local-agent-mode-sessions/.../local_*.json`. Interactive only, deduped by title. **READ-ONLY** (can't resume — see invariants), so **hidden by default** behind `const SHOW_COWORK = false`. Flip to re-enable read-only monitoring.

`session_event` / `session_attached` / `active_session` / `spawn_*` messages flow over WS; the client renders `user`/`assistant`/`result` lines.

## Auth (added 2026-07)

Everything except the PWA shell (`/`, `/index.html`, `/manifest.json`, `/sw.js`, `/icon.svg`, `/auth`) requires a shared secret: generated once into `.auth-token` (gitignored, printed at startup as `login key`), overridable via `CC_AUTH_TOKEN`. The client POSTs it to `/auth` → gets an HttpOnly `cc_auth` cookie (1 yr, `Secure` when behind https) which then covers fetch/WS/media/proxy/uploads automatically; the key itself sits in localStorage for silent re-auth. WS upgrades without a valid cookie/`?token=` are closed with code 4401 → client clears the stored key and re-prompts. `mcp-permission.js` authenticates to `/mcp-permission` via `CC_TOKEN` env (baked into `.mcp-permission.json` at startup) and is **fail-closed**: server unreachable / non-allow / unparsable response → deny. Markdown rendering is sanitized with DOMPurify (code-block copy buttons use a delegated `data-cb` listener since inline `onclick` gets stripped).

## Invariants — do not break these

- **`cwdToProjectDir(cwd) = cwd.replace(/[^a-zA-Z0-9]/g, '-')`** must match Claude Code's own escaping exactly: EVERY non-alphanumeric char → `-`, leading dashes KEPT. (An earlier version only replaced `:\/` and stripped leading `-`, which silently failed for paths with `_`/`.` and for VM paths like `/sessions/x`.)
- **Cowork is read-only.** `claude --resume <cowork cliSessionId>` returns "No conversation found" — cowork transcripts use the Desktop app's queue-based format (`queue-operation`/`last-prompt` lines). Don't try to send to them. The official two-way path is the CLI's `claude remote-control` (drives from claude.ai/code or the mobile app; can't be tapped by this PWA).
- **Self-resume guard.** `startClaude` refuses to resume a session whose cwd === `__dirname` (the PocketClaude project). Otherwise the resumed agent "helpfully" restarts the server on :3000 and kills itself mid-reply (a real self-destruct loop that bit us). The web can control any OTHER session freely.
- **Long cowork paths (>260 chars):** Node's fs handles them raw here; a manual `\\?\` prefix BREAKS Node path handling. `lp()` is intentionally a no-op.
- **Resume skips stdout**, relies on the transcript file-watcher (`fs.watch` + 2.5 s poll) to avoid duplicate events. The client also does optimistic-echo dedup (`consumeEcho`) so a web-sent message isn't shown twice.
- A web-sent turn writes to the transcript file but does **not** appear in a session that's currently open live in Desktop until it's reopened (separate processes share only the file).

## Permission modes + model (web UI selectors, persisted in localStorage)

- **Permission**: `interactive` (逐項核准) · `acceptEdits` · `bypassPermissions` (→ `--dangerously-skip-permissions`) · `plan`. `acceptEdits`/`plan` map to `--permission-mode`; `bypassPermissions` runs everything (destructive-capable).
- **`interactive` mode → real per-tool approval from the phone.** Spawns with `--permission-mode default --mcp-config .mcp-permission.json --permission-prompt-tool mcp__ccperm__approve`. **`mcp-permission.js`** (3rd file, an MCP stdio server Claude launches) receives each permission decision and POSTs it to the server's `/mcp-permission`, which broadcasts a `permission_request` over WS (+ push), holds the HTTP response until the user taps allow/deny (`permission_decision`) or a 120 s timeout auto-denies. Proven end-to-end. (`.mcp-permission.json` is generated at startup, gitignored.)
- **Model**: `default` (no flag) · `fable` · `opus` · `sonnet` · `haiku` → `--model <alias>` (aliases track the latest version of each tier).
- **Effort (思考深度)**: `default` (no flag) · `low` · `medium` · `high` · `xhigh` · `max` → `--effort <level>`.

Interactive tool cards (client): `ExitPlanMode` → markdown plan card, `TodoWrite` → checklist, `AskUserQuestion` → clickable options (click = reply). Everything else → collapsible tool chip.

## Viewing generated output on the phone

- **Media**: `GET /media?path=<abs>[&base=<cwd>][&download=1]` streams a local file with HTTP Range (iOS audio/video seek), confined to the user's home dir. Resolution order: absolute → cwd-relative → recursive search under the session dir for a file whose path ends with the requested tail (handles root-relative paths like `/stills/x.png` living under a sub-project). The client auto-detects media paths in Claude's replies and renders inline `<audio>`/`<video>`/`<img>` + download links (`base` = active session cwd).
- **Dev servers**: `app.use('/proxy', …)` reverse-proxies `/proxy/<port>/…` to `127.0.0.1:<port>`. HTML gets a `<base>` tag + absolute-asset-path rewriting so relative & root-relative URLs resolve through the prefix. WebSocket/HMR is NOT proxied (built/static sites work; live-reload dev servers load but won't hot-update). The client detects `http://localhost:PORT` in replies and renders an "open on phone" button.

## Cross-platform notes

The code is already OS-conditional: `findClaudePath()` auto-detects the CLI (Desktop bundle → standalone locations → PATH; `CLAUDE_PATH` env overrides), `claudeAppDir()` resolves the Desktop app's data dir per OS (`%APPDATA%` / `~/Library/Application Support` / `~/.config`), and `~/.claude` paths use `os.homedir()`. Sessions whose cwd lives under `os.tmpdir()` are filtered out of the resumable list (`isTempCwd`). The only per-OS decision left to the user is how to keep the server alive (Task Scheduler / `launchd` / `pm2` / `nohup`).
