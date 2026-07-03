# PocketClaude

A self-hosted PWA to **remote-control and monitor Claude Code sessions** from a phone/browser, using the Max subscription via the local `claude` CLI (no API cost). Runs on the user's own machine; reach it remotely over a Cloudflare tunnel.

## Run

```bash
npm start                 # node server.js → http://localhost:3000
npm run tunnel            # quick tunnel: npx cloudflared tunnel --url http://localhost:3000
```

For a stable URL, use a Cloudflare named tunnel pointing at `http://localhost:3000` (machine-specific setup goes in `CLAUDE.local.md`, not here).

The server is a **plain process with no supervisor** — it dies on terminal close / reboot / crash and does NOT auto-restart. Start it detached if you want it to outlive a shell.

## Architecture

- **`server.js`** — Express + `ws` (WebSocket) + `web-push` (VAPID) + `multer`. Discovers sessions, tails their JSONL transcripts, broadcasts events over WS, and spawns `claude --resume … --print` on send. Pure helpers are exported and the boot block is guarded by `require.main === module` so `require()` (tests) is side-effect-free.
- **`public/index.html`** — single-file PWA (WS client, self-hosted `marked` + `highlight.js` + `DOMPurify`, session picker/bottom-sheet, image paste/attach, iOS-keyboard handling, permission/model/effort selectors, 8-language i18n, light/dark theme, file browser, voice input). `viewer.html` = styled Markdown reader. `sw.js` = push + cache-first shell/vendor. `vendor/` = self-hosted libs + tabler-icons fonts. `manifest.json`, `icon.svg`.
- **`mcp-permission.js`** — MCP stdio server for interactive per-tool approval (fail-closed).
- **`test/server.test.js`** — `node --test` unit tests for the pure helpers; CI in `.github/workflows/ci.yml`.

## Session model (the core, non-obvious part)

Three kinds of sessions are discovered and tailed into `tailedSessions` (keyed by the CLI session id):

1. **Desktop** (`source:'desktop'`): scanned from `~/.claude/sessions/*.json` (live pid markers; removed when the window closes). Transcript: `~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl`. **Resumable** via the web. Retired by `scanSessions` when the window closes.
2. **Code history** (`source:'code'`): the most-recent session per project under `~/.claude/projects/*`, so the web can resume any recent project — not just open windows. Tailed with a 256 KB tail cap; the real cwd is read from the transcript tail (`readCwdFromTranscript`) since the escaped dir name is lossy. NOT retired by the Desktop cleanup loop, but IS retired by `scanCodeHistory` itself when a newer session replaces it as the project's most-recent (prevents unbounded tail/poll/history accumulation). Skipped if already live as a Desktop session.
3. **Cowork** (`source:'cowork'`, a.k.a. "local agent mode"): scanned from `%APPDATA%/Claude/local-agent-mode-sessions/.../local_*.json`. Interactive only, deduped by title. **READ-ONLY** (can't resume — see invariants), so **hidden by default** behind `const SHOW_COWORK = false`. Flip to re-enable read-only monitoring.

`session_event` / `session_attached` / `active_session` / `spawn_*` messages flow over WS; the client renders `user`/`assistant`/`result` lines.

## Streaming + concurrency (streaming added 2026-07)

Each session runs **one persistent streaming process** — `activeSpawns` Map keyed by `resumeSessionId` (or `'__spawn__'` for a fresh chat), entry `{ proc, mcpConfig, key, cliSessionId, buf, turnActive, idleTimer }`. Spawned with `--input-format stream-json --output-format stream-json --include-partial-messages --print` (prompt fed over stdin via `streamUserLine`, NOT as a positional). Many sessions run in parallel.

- **Follow-ups / interject:** a second send to a live session writes another user turn to its **stdin** (instant, no cold start; runs after the current turn — the CLI queues rather than interrupts). No more client-side queue or `blocked_busy`.
- **Lifecycle events:** `spawn_start`/`turn_start` → a turn began; `turn_end` (from a CLI `result`) → turn done, `turnActive=false`; `spawn_end` → process gone. The process stays alive after a turn for `STREAM_IDLE_MS` (5 min), then closes stdin and exits. `turnActive` guards against resumed sessions that emit repeated empty init+result pairs.
- **Live render (client):** `stream_delta {key,sessionId,text}` accumulates into `S[id].live.text` and paints a `.row-claude.live` bubble (rAF-throttled markdown). `stream_tool` seals the text bubble then adds a tool card. `turn_end` finalizes `live` into a permanent `{type:'text'}` msg. Fresh chats route by `rkey()` → always `'__spawn__'` (their real id is discovered mid-turn by `scanCodeHistory` but events keep key `'__spawn__'`).
- **No double render:** while `isStreaming(sessionId)`, the transcript tailer records to `history` + advances offset but **suppresses** its `session_event` broadcast (stdout already rendered it live).

`stop` targets a specific session (by key or `cliSessionId`). Each interactive spawn gets its **own** `.mcp-perm-<ts>.json` carrying `CC_SESSION` (env) so parallel permission prompts route to the right conversation via `/mcp-permission`'s `session` field. Process trees are killed with `taskkill /T` on Windows. `get_history` is **paged** (`before` offset → older 300 events, `prepend:true`); tool inputs truncated at 4 KB, unlabeled code blocks never `highlightAuto` (both were freeze sources).

## Auth (added 2026-07)

Everything except the PWA shell (`/`, `/index.html`, `/viewer.html`, `/manifest.json`, `/sw.js`, `/icon.svg`, `/auth`) requires a shared secret: generated once into `.auth-token` (gitignored, printed at startup as `login key`), overridable via `CC_AUTH_TOKEN`. The client POSTs it to `/auth` → gets an HttpOnly `cc_auth` cookie (1 yr, `Secure` when behind https) which then covers fetch/WS/media/proxy/uploads automatically; the key itself sits in localStorage for silent re-auth. WS upgrades without a valid cookie/`?token=` are closed with code 4401 → client clears the stored key and re-prompts. `mcp-permission.js` authenticates to `/mcp-permission` via `CC_TOKEN` env (baked into `.mcp-permission.json` at startup) and is **fail-closed**: server unreachable / non-allow / unparsable response → deny. Markdown rendering is sanitized with DOMPurify (code-block copy buttons use a delegated `data-cb` listener since inline `onclick` gets stripped).

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
- **Dev servers**: `app.use('/proxy', …)` reverse-proxies `/proxy/<port>/…` to `127.0.0.1:<port>`. HTML gets a `<base>` tag + absolute-asset-path rewriting so relative & root-relative URLs resolve through the prefix. WebSocket/HMR is NOT proxied (built/static sites work; live-reload dev servers load but won't hot-update). The client detects `http://localhost:PORT` in replies and renders an "open on phone" button. **Port whitelist**: only ports seen as `localhost:<port>` in a transcript/spawn output are allowed (`seenPorts`; `CC_PROXY_ALLOW` env adds more) — otherwise 403, so an authed client can't SSRF into arbitrary local services.
- **File browser**: `GET /files?path=` lists a home-confined directory (dirs first, dotfiles/node_modules skipped). `viewer.html` renders `.md`/`.txt`/`.log` with sanitized markdown; relative links inside chain back through `/media` and `/viewer.html`. Text file types (incl. `.html`) are served as `text/plain` on purpose — `text/html` would run same-origin with the auth cookie.
- **Security extras**: `/auth` brute-force throttle (5 fails/IP → 60 s lockout + 300 ms delay), `public/uploads` swept (>7 days) every 6 h, `.audit.log` (gitignored) records auth/send/stop/permission/denied-proxy events as JSON lines.

## Cross-platform notes

The code is already OS-conditional: `findClaudePath()` auto-detects the CLI (Desktop bundle → standalone locations → PATH; `CLAUDE_PATH` env overrides), `claudeAppDir()` resolves the Desktop app's data dir per OS (`%APPDATA%` / `~/Library/Application Support` / `~/.config`), and `~/.claude` paths use `os.homedir()`. Sessions whose cwd lives under `os.tmpdir()` are filtered out of the resumable list (`isTempCwd`). The only per-OS decision left to the user is how to keep the server alive (Task Scheduler / `launchd` / `pm2` / `nohup`).

## Roadmap / TODO

**Done** (this repo already ships all of these): parallel per-session tasks, **persistent streaming with token-by-token render + mid-task interject**, history pagination, 8-language UI + READMEs, light/dark themes, thinking-effort + model selectors (incl. Fable 5), ⚙ advanced-CLI-flags menu (fork/worktree/read-only/…), file browser + Markdown viewer, dev-server `/proxy` (dual-stack + referer/cookie fallback), push deep-links, voice input, in-page login + nav reload button, security batch (proxy port whitelist, `/auth` throttle, upload sweep, `.audit.log`), self-hosted assets + offline SW, unit tests + CI, v1.1.0 tag.

**Not doing** (deliberately declined — see `[[pocketclaude-auth-preference]]`): per-device tokens / QR / WebAuthn — the single shared key is preferred. Task Scheduler watchdog — user keeps the server manual/detached.

**Candidate next steps**, roughly by value:
1. **Multi-machine fleet** — one web client fronting several PocketClaude servers (home desktop + work laptop). The one thing the official `remote-control` (single-machine) can't do. Needs a server registry + per-server auth in the client.
2. **Output gallery** — scan each session's generated images/video/audio into a browsable wall (pairs well with the user's ComfyUI / marketing-short / video pipelines).
3. **Usage dashboard** — `result` events carry cost/duration; aggregate per-project daily spend.
4. **Small polish** — session pin/archive (list is 12+), an optional "show thinking" toggle (currently `slim()` strips it), detect + label sessions that have an official `remote-control` channel.
