const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const webpush = require('web-push');
const multer = require('multer');
const os = require('os');
require('dotenv').config();

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 20 * 1024 * 1024 } });

// Uploaded images are transient (Claude reads them once) — sweep files older
// than 7 days so the folder doesn't grow forever.
function sweepUploads() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  try {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
// (started in the boot block below, guarded so `require()` in tests is side-effect-free)

// Cross-platform: the Claude Desktop app's data directory.
function claudeAppDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  return path.join(home, '.config', 'Claude');   // linux
}

// Cross-platform: locate the `claude` CLI binary.
function findClaudePath() {
  if (process.env.CLAUDE_PATH && fs.existsSync(process.env.CLAUDE_PATH)) return process.env.CLAUDE_PATH;
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const tryPaths = [];
  // Claude Desktop's bundled CLI (newest version dir first)
  const ccBase = path.join(claudeAppDir(), 'claude-code');
  try {
    for (const v of fs.readdirSync(ccBase).filter(v => /^\d/.test(v)).sort().reverse()) tryPaths.push(path.join(ccBase, v, exe));
  } catch {}
  // standalone installer / common locations
  tryPaths.push(path.join(home, '.claude', 'local', exe));
  if (process.platform !== 'win32') tryPaths.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  for (const p of tryPaths) { try { if (fs.existsSync(p)) return p; } catch {} }
  // fall back to PATH lookup
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    const out = execSync(cmd, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch {}
  return 'claude';   // last resort: rely on PATH at spawn time
}

const CLAUDE_PATH = findClaudePath();
const PORT = process.env.PORT || 3000;
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');

// Cowork ("local agent mode") sessions live in the Desktop app's data dir,
// with their own nested .claude and very long transcript paths.
const COWORK_DIR = path.join(claudeAppDir(), 'local-agent-mode-sessions');
// Cowork is READ-ONLY (can't be resumed), so it's hidden by default — flip to
// re-enable read-only monitoring. We instead list resumable Claude Code sessions.
const SHOW_COWORK = false;
const MAX_FULL_READ = 16 * 1024 * 1024; // read the whole transcript below this; above, only the tail

// Cowork transcript paths exceed 260 chars, but Node's fs handles them natively
// here — and a manual \\?\ extended prefix actually breaks Node's path handling.
// So this is intentionally a no-op; raw paths work for stat/open/read/watch.
function lp(p) { return p; }

// ── Auth: a single shared secret gates everything except the PWA shell. ──
// Generated once and persisted to .auth-token (gitignored); override with
// CC_AUTH_TOKEN. The client stores it, exchanges it for an HttpOnly cookie via
// POST /auth, and the cookie then covers fetch/WS/media/proxy automatically.
const TOKEN_FILE = path.join(__dirname, '.auth-token');
let AUTH_TOKEN = (process.env.CC_AUTH_TOKEN || '').trim();
if (!AUTH_TOKEN) {
  try { AUTH_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!AUTH_TOKEN) {
    AUTH_TOKEN = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(TOKEN_FILE, AUTH_TOKEN);
  }
}
function tokenOk(t) {
  if (!t) return false;
  const a = Buffer.from(String(t)), b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Token can arrive as a Bearer header, ?token= query, or the cc_auth cookie.
function reqToken(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  try {
    const q = new URL(req.url, 'http://x').searchParams.get('token');
    if (q) return q;
  } catch {}
  const m = /(?:^|;\s*)cc_auth=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
// ── Audit log: one JSON line per security-relevant action (.audit.log, gitignored).
const AUDIT_FILE = path.join(__dirname, '.audit.log');
function reqIp(req) {
  return (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || '';
}
function audit(ev, detail) {
  try { fs.appendFileSync(AUDIT_FILE, JSON.stringify({ t: new Date().toISOString(), ev, ...detail }) + '\n'); } catch {}
}

// ── /auth brute-force throttle: 5 failures per IP → 60 s lockout, plus a small
// constant delay on every failure. (The key has ~192 bits of entropy; this is
// hygiene, not the real defence.)
const authFails = new Map();   // ip -> { fails, until }
function authThrottled(ip) {
  const e = authFails.get(ip);
  return !!(e && e.until && Date.now() < e.until);
}
function authFailed(ip) {
  const e = authFails.get(ip) || { fails: 0, until: 0 };
  e.fails++;
  if (e.fails >= 5) { e.until = Date.now() + 60000; e.fails = 0; }
  authFails.set(ip, e);
}

function setAuthCookie(req, res) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `cc_auth=${encodeURIComponent(AUTH_TOKEN)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
}

const app = express();
app.use(express.json());

// The shell (no secrets) loads without auth so the login screen can render;
// every other route — API, WS, /media, /proxy, /uploads — requires the token.
const PUBLIC_PATHS = new Set(['/', '/index.html', '/viewer.html', '/app.webmanifest', '/sw.js', '/icon.svg', '/auth']);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  // Bundled libs are part of the shell: the login screen itself needs them
  // BEFORE any cookie exists (a 401 here bricks first load on a new device).
  // Named /assets/, NOT /vendor/ — Cloudflare's managed WAF blocks /vendor/*
  // (composer-attack heuristic) and 403s the whole app through a tunnel.
  if (req.path.startsWith('/assets/')) return next();
  if (tokenOk(reqToken(req))) return next();
  res.status(401).json({ error: 'unauthorized' });
});
app.use(express.static(path.join(__dirname, 'public')));

// Exchange the shared secret for the auth cookie (so media/proxy URLs work
// without ?token= on every link).
app.post('/auth', (req, res) => {
  const ip = reqIp(req);
  if (authThrottled(ip)) { audit('auth_locked', { ip }); return res.status(429).json({ error: 'too many attempts, wait a minute' }); }
  const t = (req.body && req.body.token) || reqToken(req);
  if (!tokenOk(t)) {
    authFailed(ip);
    audit('auth_fail', { ip });
    return setTimeout(() => res.status(401).json({ error: 'bad token' }), 300);
  }
  authFails.delete(ip);
  audit('auth_ok', { ip });
  setAuthCookie(req, res);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Web Push
const vapidKeys = (() => {
  const keyFile = path.join(__dirname, '.vapid.json');
  if (fs.existsSync(keyFile)) return JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(keyFile, JSON.stringify(keys));
  return keys;
})();
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

// Push subscriptions persisted to disk (keyed by endpoint) so they survive restarts.
const SUBS_FILE = path.join(__dirname, '.push-subs.json');
const pushSubscriptions = new Map();   // endpoint -> subscription
(() => {
  try {
    for (const sub of JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'))) {
      if (sub && sub.endpoint) pushSubscriptions.set(sub.endpoint, sub);
    }
  } catch {}
})();
function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify([...pushSubscriptions.values()])); } catch {}
}

const connectedClients = new Set();

// One spawn PER SESSION may run concurrently (key: resumeSessionId or
// '__spawn__' for a fresh chat). Each entry: { proc, mcpConfig }.
const activeSpawns = new Map();

// Kill the whole process tree — on Windows, proc.kill() leaves claude's
// children (node subprocesses, shells) running.
function killTree(proc) {
  if (!proc) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch { try { proc.kill(); } catch {} }
  } else {
    try { proc.kill(); } catch {}
  }
}
function killSpawn(key) { killTree(activeSpawns.get(key)?.proc); }
function killAllSpawns() { for (const s of activeSpawns.values()) killTree(s.proc); }

// Track tailed JSONL files: sessionId -> { path, size }
const tailedSessions = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const c of connectedClients) if (c.readyState === 1) c.send(msg);
}

// Push notifications are rendered PER SUBSCRIBER in the language that device
// registered with (/subscribe carries `lang`). Keys: <kind> = title, <kind>_b = body.
const PUSH_I18N = {
  'zh-TW': { done:'Claude 完成了', done_b:'{n} 結束', perm:'需要授權 🔐', perm_b:'{n} 等待核准', test:'PocketClaude 測試 🔔', test_b:'推播正常運作！' },
  'zh-CN': { done:'Claude 完成了', done_b:'{n} 结束', perm:'需要授权 🔐', perm_b:'{n} 等待批准', test:'PocketClaude 测试 🔔', test_b:'推送正常工作！' },
  en: { done:'Claude finished', done_b:'{n} is done', perm:'Approval needed 🔐', perm_b:'{n} awaits your approval', test:'PocketClaude test 🔔', test_b:'Push is working!' },
  ja: { done:'Claude が完了', done_b:'{n} が終了しました', perm:'承認が必要 🔐', perm_b:'{n} が承認待ちです', test:'PocketClaude テスト 🔔', test_b:'プッシュ通知は正常です！' },
  ko: { done:'Claude 완료', done_b:'{n} 종료', perm:'승인 필요 🔐', perm_b:'{n} 승인 대기 중', test:'PocketClaude 테스트 🔔', test_b:'푸시가 정상 작동해요!' },
  es: { done:'Claude terminó', done_b:'{n} finalizado', perm:'Aprobación necesaria 🔐', perm_b:'{n} espera tu aprobación', test:'Prueba de PocketClaude 🔔', test_b:'¡Las notificaciones funcionan!' },
  fr: { done:'Claude a terminé', done_b:'{n} terminé', perm:'Approbation requise 🔐', perm_b:'{n} attend votre accord', test:'Test PocketClaude 🔔', test_b:'Les notifications fonctionnent !' },
  de: { done:'Claude ist fertig', done_b:'{n} abgeschlossen', perm:'Freigabe nötig 🔐', perm_b:'{n} wartet auf Freigabe', test:'PocketClaude-Test 🔔', test_b:'Push funktioniert!' },
};
async function sendPush(kind, name, data) {
  let changed = false;
  for (const [endpoint, sub] of pushSubscriptions) {
    const L = PUSH_I18N[sub.lang] || PUSH_I18N['zh-TW'];
    const title = L[kind] || kind;
    const body = (L[kind + '_b'] || '').replace('{n}', name || 'Claude');
    try { await webpush.sendNotification(sub, JSON.stringify({ title, body, ...data })); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { pushSubscriptions.delete(endpoint); changed = true; }
    }
  }
  if (changed) saveSubs();
  console.log(`Push "${kind}" → ${pushSubscriptions.size} subscriber(s)`);
}

// Convert cwd path to Claude's project dir name.
// Claude Code escapes EVERY non-alphanumeric char to '-' and keeps leading dashes
// (e.g. "C:\a_b" -> "C--a-b", "/sessions/x" -> "-sessions-x").
function cwdToProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Parse JSONL lines into events
function parseLines(lines) {
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

// Only events the client renders. Drops bulky attachment / queue-operation /
// ai-title / mode / last-prompt lines that bloat a transcript without content.
function renderable(ev) {
  return ev && (ev.type === 'user' || ev.type === 'assistant' || ev.type === 'result');
}

// Strip content blocks the client never renders (assistant `thinking`, user
// `tool_result`/`image`) — they can be megabytes each and bloat the payload.
// Long strings inside tool_use inputs (Write file bodies, huge Edits) are also
// truncated: the client only shows them in a collapsible chip, and full-size
// inputs were the main reason history payloads reached tens of MB.
function truncStr(s, cap) {
  return typeof s === 'string' && s.length > cap ? s.slice(0, cap) + '\n… [truncated]' : s;
}
function slimBlock(b) {
  if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
    const input = {};
    for (const [k, v] of Object.entries(b.input)) input[k] = truncStr(v, 4000);
    return { ...b, input };
  }
  if (b.type === 'text') return { ...b, text: truncStr(b.text, 50000) };
  return b;
}
function slim(ev) {
  const c = ev.message?.content;
  if (!Array.isArray(c)) return ev;
  const keep = (ev.type === 'assistant'
    ? c.filter(b => b.type === 'text' || b.type === 'tool_use')
    : c.filter(b => b.type === 'text')).map(slimBlock);
  return { ...ev, message: { ...ev.message, content: keep } };
}

// /proxy is only allowed to reach ports that actually appeared as
// localhost:<port> in some session's transcript (or CC_PROXY_ALLOW env) —
// an authenticated client shouldn't get a free SSRF into every local service.
const seenPorts = new Set(
  String(process.env.CC_PROXY_ALLOW || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean));
function scanPorts(str) {
  const re = /(?:localhost|127\.0\.0\.1):(\d{2,5})/g;
  let m; while ((m = re.exec(str))) { const p = parseInt(m[1], 10); if (p > 0 && p <= 65535) seenPorts.add(p); }
}

function tailJsonl(sessionId, jsonlPath, cwd, kind, opts = {}) {
  if (tailedSessions.has(sessionId)) return;
  const P = lp(jsonlPath);
  let stat; try { stat = fs.statSync(P); } catch { return; }

  // Read the whole transcript and keep only renderable events (small payload,
  // full conversation). Only pathologically huge files fall back to a tail read.
  let history = [];
  try {
    let text;
    if (stat.size > MAX_FULL_READ) {
      const cap = 1024 * 1024;
      const buf = Buffer.alloc(cap);
      const fd = fs.openSync(P, 'r');
      fs.readSync(fd, buf, 0, cap, stat.size - cap);
      fs.closeSync(fd);
      text = buf.toString('utf8');
      text = text.slice(text.indexOf('\n') + 1);   // drop the partial first line
    } else {
      text = fs.readFileSync(P, 'utf8');
    }
    history = parseLines(text.split('\n').filter(Boolean)).filter(renderable).map(slim);
    scanPorts(text);
  } catch {}

  const entry = {
    path: jsonlPath, P, offset: stat.size, cwd, kind: kind || '',
    source: opts.source || 'desktop', displayName: opts.displayName || '',
    projectDir: opts.projectDir || '', history,
  };
  tailedSessions.set(sessionId, entry);

  const readNew = () => {
    try {
      const st = fs.statSync(entry.P);
      if (st.size <= entry.offset) return;
      const buf = Buffer.alloc(st.size - entry.offset);
      const fd = fs.openSync(entry.P, 'r');
      fs.readSync(fd, buf, 0, buf.length, entry.offset);
      fs.closeSync(fd);
      entry.offset = st.size;
      scanPorts(buf.toString('utf8'));
      for (const ev of parseLines(buf.toString('utf8').split('\n').filter(Boolean))) {
        if (!renderable(ev)) continue;
        const e = slim(ev);
        entry.history.push(e);
        broadcast({ type: 'session_event', sessionId, event: e });
      }
    } catch {}
  };

  // fs.watch is unreliable on very long paths → back it up with polling.
  try { entry.watcher = fs.watch(entry.P, { persistent: true }, readNew); } catch {}
  entry.poll = setInterval(readNew, 2500);

  const projectName = opts.displayName || (cwd ? path.basename(cwd) : sessionId.slice(0, 8));
  broadcast({ type: 'session_attached', sessionId, projectName });
  console.log(`Attached to ${entry.source} session ${projectName} (${sessionId})`);
}

function stopTail(sessionId) {
  const s = tailedSessions.get(sessionId);
  if (!s) return;
  s.watcher?.close();
  clearInterval(s.poll);
  tailedSessions.delete(sessionId);
  broadcast({ type: 'session_detached', sessionId });
}

// Discover interactive Cowork sessions and tail their (read-only) transcripts.
function scanCowork() {
  if (!COWORK_DIR || !fs.existsSync(COWORK_DIR)) return;
  const descriptors = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^local_/.test(e.name)) walk(p, depth + 1); }
      else if (/^local_[0-9a-f-]+\.json$/.test(e.name)) descriptors.push(p);
    }
  };
  walk(COWORK_DIR, 0);

  // Collect eligible interactive sessions, then keep only the most-recent per title
  // (the same task gets re-run under one title — one entry is enough).
  const byTitle = new Map();
  for (const dp of descriptors) {
    let d; try { d = JSON.parse(fs.readFileSync(dp, 'utf8')); } catch { continue; }
    if (d.isArchived || !d.cliSessionId || !d.cwd) continue;
    if (/^\s*<scheduled-task/.test(d.initialMessage || '')) continue;  // skip automated runs
    const id = d.cliSessionId;
    const sessionDir = path.join(path.dirname(dp), d.sessionId);
    const transcript = path.join(sessionDir, '.claude', 'projects', cwdToProjectDir(d.cwd), id + '.jsonl');
    let mtime; try { mtime = fs.statSync(transcript).mtimeMs; } catch { continue; }  // no transcript → skip
    const title = d.title || ('cowork ' + id.slice(0, 6));
    const folder = (d.userSelectedFolders && d.userSelectedFolders[0]) || d.cwd;
    const prev = byTitle.get(title);
    if (!prev || mtime > prev.mtime) byTitle.set(title, { id, transcript, title, folder, mtime });
  }

  for (const c of byTitle.values()) {
    if (tailedSessions.has(c.id)) continue;
    tailJsonl(c.id, c.transcript, c.folder, 'cowork', { displayName: c.title, source: 'cowork' });
    broadcast({ type: 'active_session', sessionId: c.id, cwd: c.folder, kind: 'cowork', projectName: c.title });
  }
}

// The real cwd of a session isn't recoverable from the escaped project-dir name
// (escaping is lossy), so read it from a transcript line that carries `cwd`. Read
// the TAIL — the head can be one huge first message with no usable line.
function readCwdFromTranscript(p) {
  try {
    const size = fs.statSync(p).size;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i]); if (o.cwd) return o.cwd; } catch {}
    }
  } catch {}
  return null;
}

// Sessions whose cwd lives in the OS temp dir are throwaway runs (test
// harnesses, scratch spawns) — never list them as resumable projects.
const TMP_DIR = os.tmpdir();
const TMP_PROJECT_PREFIX = cwdToProjectDir(TMP_DIR) + '-';
function isTempCwd(cwd, projectDirName) {
  if (projectDirName && projectDirName.startsWith(TMP_PROJECT_PREFIX)) return true;
  if (!cwd) return false;
  const a = process.platform === 'win32' ? String(cwd).toLowerCase() : String(cwd);
  const t = process.platform === 'win32' ? TMP_DIR.toLowerCase() : TMP_DIR;
  return a === t || a.startsWith(t + path.sep);
}

// List the most-recent (resumable) Claude Code session per project from history,
// so the web can control any recent project — not just currently-open windows.
function scanCodeHistory() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  let dirs; try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    if (isTempCwd(null, dir.name)) continue;   // temp-dir project → skip before any file I/O
    const pdir = path.join(PROJECTS_DIR, dir.name);
    let files; try { files = fs.readdirSync(pdir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    let best = null, bestM = 0;
    for (const f of files) {
      try { const m = fs.statSync(path.join(pdir, f)).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch {}
    }
    if (!best) continue;
    const sessionId = best.replace(/\.jsonl$/, '');
    if (tailedSessions.has(sessionId)) continue;        // already live (open Desktop window)
    // A newer session replaced this project's previous one — retire the old
    // tail (its watcher + poll timer + in-RAM history) instead of accumulating.
    for (const [sid, s] of tailedSessions) {
      if (s.source === 'code' && s.projectDir === dir.name) stopTail(sid);
    }
    const transcript = path.join(pdir, best);
    const cwd = readCwdFromTranscript(transcript) || dir.name;
    if (isTempCwd(cwd, dir.name)) continue;   // real cwd turned out to be temp
    tailJsonl(sessionId, transcript, cwd, '', { source: 'code', projectDir: dir.name });
    broadcast({ type: 'active_session', sessionId, cwd, kind: '' });
  }
}

// Watch ~/.claude/sessions/ for open Desktop sessions + list resumable code sessions
function watchSessions() {
  const scanSessions = () => {
    const active = new Set();
    try {
      for (const file of fs.readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith('.json')) continue;
        let info;
        try { info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')); } catch { continue; }
        const { sessionId, cwd, kind } = info;
        if (!sessionId || !cwd) continue;
        active.add(sessionId);
        if (!tailedSessions.has(sessionId)) {
          const jsonlPath = path.join(PROJECTS_DIR, cwdToProjectDir(cwd), sessionId + '.jsonl');
          tailJsonl(sessionId, jsonlPath, cwd, kind);
          broadcast({ type: 'active_session', sessionId, cwd, kind });
        }
      }
    } catch {}
    // Only retire Desktop sessions that closed — never the read-only Cowork ones.
    for (const [sid, s] of tailedSessions) {
      if (s.source === 'desktop' && !active.has(sid)) stopTail(sid);
    }
  };

  if (fs.existsSync(SESSIONS_DIR)) {
    scanSessions();
    try { fs.watch(SESSIONS_DIR, { persistent: true }, scanSessions); } catch {}
    setInterval(scanSessions, 5000);
  }

  scanCodeHistory();
  setInterval(scanCodeHistory, 10000);

  if (SHOW_COWORK) {            // cowork is read-only → hidden by default
    scanCowork();
    setInterval(scanCowork, 15000);
  }
}

// Permission modes / models the web UI may request
const PERM_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
const MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku']);   // 'default' → don't pass --model
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);   // 'default' → don't pass --effort

// MCP config for the interactive permission-prompt tool. Written PER SPAWN so
// each config carries CC_SESSION — with parallel spawns the /mcp-permission
// POST must say which session it belongs to (the MCP process itself is the
// only thing that knows).
function writeMcpConfig(key) {
  const p = path.join(__dirname, `.mcp-perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    mcpServers: { ccperm: { type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'mcp-permission.js')], env: { CC_PORT: String(PORT), CC_TOKEN: AUTH_TOKEN, CC_SESSION: key } } },
  }));
  return p;
}

// Pending interactive permission prompts: id -> { res, timer }
const pendingPerms = new Map();
let permSeq = 0;

// Tools denied in read-only mode: nothing that mutates the machine.
const READONLY_DENY = ['Write', 'Edit', 'NotebookEdit', 'Bash'];

// Build the claude CLI argument list — pure, so it's unit-testable.
// `adv` = advanced options from the web UI's ⚙ menu; every value is validated
// or clamped here, never trusted verbatim.
function buildSpawnArgs({ prompt, resumeSessionId, permissionMode, model, effort, adv = {}, mcpConfig = null }) {
  const args = ['--output-format', 'stream-json', '--verbose'];
  if (permissionMode === 'interactive') {
    args.push('--permission-mode', 'default', '--mcp-config', mcpConfig, '--permission-prompt-tool', 'mcp__ccperm__approve');
  } else if (permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');           // canonical flag, all versions
  } else if (permissionMode && PERM_MODES.has(permissionMode)) {
    args.push('--permission-mode', permissionMode);
  }
  if (model && MODELS.has(model)) args.push('--model', model);
  if (effort && EFFORTS.has(effort)) args.push('--effort', effort);
  if (adv.fallbackModel && MODELS.has(adv.fallbackModel)) args.push('--fallback-model', adv.fallbackModel);
  if (adv.fork && resumeSessionId) args.push('--fork-session');
  if (adv.worktree) args.push('--worktree');
  if (adv.readonly) args.push('--disallowedTools', ...READONLY_DENY);
  if (adv.continueRecent && !resumeSessionId) args.push('--continue');
  if (adv.name && typeof adv.name === 'string') args.push('--name', adv.name.slice(0, 60));
  if (adv.addDirs) {
    for (const d of String(adv.addDirs).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 5)) {
      args.push('--add-dir', d);
    }
  }
  if (adv.sysPrompt) args.push('--append-system-prompt', String(adv.sysPrompt).slice(0, 2000));
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  args.push('--print', prompt);
  return args;
}

// --- Spawn / resume Claude session ---
function startClaude(cwd, prompt, resumeSessionId, permissionMode, model, effort, adv) {
  // Guard: never let the web resume PocketClaude's OWN managing session. Its whole
  // context is "run the server on :3000", so the resumed agent helpfully restarts
  // it — killing this very server mid-reply (the self-destruct loop).
  const tcwd = resumeSessionId && tailedSessions.get(resumeSessionId)?.cwd;
  const target = cwd || tcwd;
  if (target && path.resolve(target) === path.resolve(__dirname)) {
    broadcast({ type: 'spawn_blocked', sessionId: resumeSessionId, reasonKey: 'blocked_self',
      reason: '不能從網頁操控 PocketClaude 自己的對話 — 它會重啟並殺掉這個伺服器。請改選其他 session。' });
    return;
  }

  // One spawn per SESSION — a second send to the same session is refused
  // (the client queues it instead); other sessions run in parallel.
  const key = resumeSessionId || '__spawn__';
  if (activeSpawns.has(key)) {
    broadcast({ type: 'spawn_blocked', sessionId: resumeSessionId, key, reasonKey: 'blocked_busy',
      reason: '這個 session 已有任務進行中。' });
    return;
  }

  let mcpConfig = null;
  if (permissionMode === 'interactive') mcpConfig = writeMcpConfig(key);   // route approvals to the phone
  const args = buildSpawnArgs({ prompt, resumeSessionId, permissionMode, model, effort, adv: adv || {}, mcpConfig });

  // Use cwd from tailed session if resuming
  const effectiveCwd = cwd || (resumeSessionId && tailedSessions.get(resumeSessionId)?.cwd) || process.cwd();
  const proc = spawn(CLAUDE_PATH, args, { cwd: effectiveCwd, env: process.env });
  activeSpawns.set(key, { proc, mcpConfig });
  broadcast({ type: 'spawn_start', cwd: effectiveCwd, resumeSessionId, key });

  proc.stdout.on('data', chunk => {
    scanPorts(chunk.toString());
    // When resuming, JSONL file watcher already picks up new events — skip stdout to avoid duplicates
    if (resumeSessionId) return;
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      try { broadcast({ type: 'spawn_event', event: JSON.parse(line) }); }
      catch { broadcast({ type: 'spawn_raw', text: line }); }
    }
  });
  proc.stderr.on('data', chunk => broadcast({ type: 'spawn_stderr', text: chunk.toString() }));
  proc.on('close', code => {
    activeSpawns.delete(key);
    if (mcpConfig) { try { fs.unlinkSync(mcpConfig); } catch {} }
    broadcast({ type: 'spawn_end', code, resumeSessionId, key });
    const s = resumeSessionId && tailedSessions.get(resumeSessionId);
    sendPush('done', s ? path.basename(s.cwd || '') : '', { sessionId: resumeSessionId || '' });
  });
}

// WebSocket — the upgrade request carries the cc_auth cookie (same-origin) or
// a ?token= fallback; reject anything else before it can see session data.
wss.on('connection', (ws, req) => {
  if (!tokenOk(reqToken(req))) { audit('ws_denied', { ip: reqIp(req) }); ws.close(4401, 'unauthorized'); return; }
  const ip = reqIp(req);
  connectedClients.add(ws);

  // Send session list WITHOUT history (lazy-loaded per session on demand — the
  // combined history of all sessions can be tens of MB, far too much on mobile).
  const sessions = [];
  for (const [sessionId, s] of tailedSessions) {
    let lastModified = 0;
    try { lastModified = fs.statSync(s.P || lp(s.path)).mtimeMs; } catch {}
    sessions.push({
      sessionId,
      projectName: s.displayName || (s.cwd ? path.basename(s.cwd) : sessionId.slice(0, 8)),
      cwd: s.cwd || '',
      kind: s.kind || '',
      lastModified,
    });
  }
  ws.send(JSON.stringify({ type: 'init', sessions, busy: [...activeSpawns.keys()] }));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'send') {
      const advUsed = msg.adv && typeof msg.adv === 'object'
        ? Object.keys(msg.adv).filter(k => msg.adv[k]) : [];
      audit('send', { ip, session: msg.resumeSessionId || '(new)', cwd: msg.cwd || '', mode: msg.permissionMode, model: msg.model, adv: advUsed, len: (msg.text || '').length });
      startClaude(msg.cwd, msg.text, msg.resumeSessionId, msg.permissionMode, msg.model, msg.effort, msg.adv);
    }
    else if (msg.type === 'stop') {
      audit('stop', { ip, key: msg.key || msg.sessionId || '(all)' });
      if (msg.sessionId || msg.key) killSpawn(msg.key || msg.sessionId); else killAllSpawns();
    }
    else if (msg.type === 'get_history') {
      // Paged: default = latest 300 events; `before` (an index into the history
      // array, from a previous response's `offset`) pages further back.
      const s = tailedSessions.get(msg.sessionId);
      const h = s?.history || [];
      const before = Number.isInteger(msg.before) && msg.before >= 0 ? Math.min(msg.before, h.length) : h.length;
      const start = Math.max(0, before - 300);
      ws.send(JSON.stringify({
        type: 'history', sessionId: msg.sessionId,
        history: h.slice(start, before), offset: start, total: h.length,
        prepend: Number.isInteger(msg.before),
      }));
    }
    else if (msg.type === 'permission_decision') {
      const p = pendingPerms.get(msg.id);
      if (p) {
        clearTimeout(p.timer); pendingPerms.delete(msg.id);
        audit('permission_decision', { ip, id: msg.id, behavior: msg.behavior });
        p.res.json({ behavior: msg.behavior === 'deny' ? 'deny' : 'allow' });
        broadcast({ type: 'permission_resolved', id: msg.id, behavior: msg.behavior });
      }
    }
  });

  ws.on('close', () => connectedClients.delete(ws));
});

// REST
app.get('/vapid-public-key', (_, res) => res.json({ key: vapidKeys.publicKey }));
app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
  pushSubscriptions.set(sub.endpoint, sub);
  saveSubs();
  res.json({ ok: true, total: pushSubscriptions.size });
});
app.post('/test-push', async (_, res) => {
  await sendPush('test', '', { tag: 'test' });
  res.json({ ok: true, subscribers: pushSubscriptions.size });
});

// Image upload — save with proper extension, serve via /uploads/
app.post('/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const ext = req.file.mimetype.split('/')[1]?.replace('jpeg','jpg') || 'png';
  const newName = req.file.filename + '.' + ext;
  const newPath = path.join(UPLOADS_DIR, newName);
  fs.renameSync(req.file.path, newPath);
  res.json({ path: '/uploads/' + newName, disk: newPath });
});

// Stream a local file (audio/image/video/docs Claude generated) so the phone can
// play/download it. Restricted to the user's home dir; Range support for media seek.
const MEDIA_MIME = {
  '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.aac':'audio/aac',
  '.ogg':'audio/ogg', '.oga':'audio/ogg', '.flac':'audio/flac', '.opus':'audio/opus',
  '.mp4':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
  '.webp':'image/webp', '.svg':'image/svg+xml', '.pdf':'application/pdf',
  // Text files render inline in the browser. Everything (incl. .html/.svg-as-doc)
  // is served as text/plain ON PURPOSE — an HTML file served as text/html would
  // execute same-origin with the auth cookie (stored-XSS via any file under home).
  '.md':'text/plain; charset=utf-8', '.txt':'text/plain; charset=utf-8',
  '.log':'text/plain; charset=utf-8', '.json':'text/plain; charset=utf-8',
  '.csv':'text/plain; charset=utf-8', '.html':'text/plain; charset=utf-8',
  '.js':'text/plain; charset=utf-8', '.ts':'text/plain; charset=utf-8',
  '.py':'text/plain; charset=utf-8', '.yaml':'text/plain; charset=utf-8',
  '.yml':'text/plain; charset=utf-8', '.toml':'text/plain; charset=utf-8',
};
// Find a file whose path ends with `relTail` somewhere under `base` (handles
// root-relative paths like /stills/x.png that live under a sub-project folder).
function findUnder(base, relTail) {
  const target = '/' + relTail.replace(/^[\\/]+/, '').replace(/\\/g, '/').toLowerCase();
  let found = null;
  const walk = (dir, depth) => {
    if (found || depth > 8) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (found) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
        walk(p, depth + 1);
      } else if (('/' + p.replace(/\\/g, '/').toLowerCase()).endsWith(target)) {
        found = p;
      }
    }
  };
  walk(base, 0);
  return found;
}

app.get('/media', (req, res) => {
  const raw = req.query.path;
  if (!raw) return res.status(400).end('no path');
  const home = os.homedir();
  const underHome = p => {
    const a = process.platform === 'win32' ? p.toLowerCase() : p;
    const h = process.platform === 'win32' ? home.toLowerCase() : home;
    return a === h || a.startsWith(h + path.sep);   // exact prefix boundary — "C:\Users\ak020-evil" must NOT pass
  };
  // Try the path as absolute; if that's not a real file, resolve it relative to
  // the session's cwd (Claude often writes project-root-relative paths like /stills/x).
  const candidates = [];
  try { candidates.push(path.resolve(raw)); } catch {}
  if (req.query.base) { try { candidates.push(path.resolve(req.query.base, raw.replace(/^[\\/]+/, ''))); } catch {} }
  let abs = null, stat = null;
  for (const c of candidates) {
    if (!underHome(c)) continue;                    // stay inside the user's home dir
    try { const st = fs.statSync(c); if (st.isFile()) { abs = c; stat = st; break; } } catch {}
  }
  // Fallback: search the session dir for a file matching the relative tail.
  if (!abs && req.query.base) {
    const baseAbs = path.resolve(req.query.base);
    if (underHome(baseAbs)) {
      const hit = findUnder(baseAbs, raw);
      if (hit && underHome(hit)) { try { const st = fs.statSync(hit); if (st.isFile()) { abs = hit; stat = st; } } catch {} }
    }
  }
  if (!abs) return res.status(404).end('not found (or outside home)');
  const ext = path.extname(abs).toLowerCase();
  const type = MEDIA_MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);
  const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = parseInt(range[1], 10);
    const end = range[2] ? parseInt(range[2], 10) : stat.size - 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(abs).pipe(res);
  }
});
// List a directory (for the file browser). Confined to the user's home dir,
// like /media. Returns dirs first, then files, each with size/mtime.
app.get('/files', (req, res) => {
  const home = os.homedir();
  const underHome = p => {
    const a = process.platform === 'win32' ? p.toLowerCase() : p;
    const h = process.platform === 'win32' ? home.toLowerCase() : home;
    return a === h || a.startsWith(h + path.sep);
  };
  let dir; try { dir = path.resolve(req.query.path || home); } catch { return res.status(400).json({ error: 'bad path' }); }
  if (!underHome(dir)) return res.status(403).json({ error: 'outside home' });
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return res.status(404).json({ error: 'not a directory' }); }
  const items = [];
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;   // skip dotfiles / deps clutter
    const full = path.join(dir, e.name);
    let size = 0, mtime = 0;
    try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
    items.push({ name: e.name, path: full, dir: e.isDirectory(), size, mtime });
  }
  items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  res.json({ path: dir, parent: (parent !== dir && underHome(parent)) ? parent : null, items });
});

app.post('/run', (req, res) => {
  if (!req.body.prompt) return res.status(400).json({ error: 'prompt required' });
  startClaude(req.body.cwd, req.body.prompt);
  res.json({ ok: true });
});
app.post('/stop', (_, res) => { killAllSpawns(); res.json({ ok: true }); });
app.get('/status', (_, res) => res.json({
  spawnRunning: activeSpawns.size > 0,
  running: [...activeSpawns.keys()],
  sessions: [...tailedSessions.keys()],
}));

// The MCP permission tool calls this; we ask the phone and hold the response
// until the user decides (or a timeout auto-denies so the agent never hangs).
app.post('/mcp-permission', (req, res) => {
  const { tool_name, input, session } = req.body || {};
  const sessionId = session && session !== '__spawn__' ? session : null;
  const id = 'perm' + (++permSeq);
  const timer = setTimeout(() => {
    if (pendingPerms.has(id)) {
      pendingPerms.delete(id);
      res.json({ behavior: 'deny', message: '逾時未回應' });
      broadcast({ type: 'permission_resolved', id, behavior: 'timeout' });
    }
  }, 120000);
  pendingPerms.set(id, { res, timer });
  broadcast({ type: 'permission_request', id, sessionId, toolName: tool_name || 'tool', input: input || {} });
  sendPush('perm', tool_name || 'tool', { sessionId: sessionId || '' });
});

// Forward one request to a local dev server. Used by /proxy/<port>/… AND by
// the referer-based fallback below (JS inside a proxied page fetches absolute
// paths like /api/x that can't be rewritten — they land on our origin and get
// routed back to the right port here).
function forwardToPort(port, pathWithQuery, req, res) {
  const prefix = '/proxy/' + port;
  const headers = { ...req.headers, host: 'localhost:' + port, 'accept-encoding': 'identity' };
  delete headers['if-none-match']; delete headers['if-modified-since'];

  // Buffer the request body so a dual-stack retry can resend it.
  const bodyChunks = [];
  req.on('data', c => bodyChunks.push(c));
  req.on('end', () => {
    // Dev servers bind IPv4 (127.0.0.1) or IPv6-only (::1 — Vite on Windows
    // does this) unpredictably — try v4 first, fall back to v6 on refusal.
    const attempt = (hostAddr, canRetry) => {
      const preq = http.request({ host: hostAddr, port, path: pathWithQuery, method: req.method, headers }, pres => {
        const ct = pres.headers['content-type'] || '';
        const out = { ...pres.headers };
        delete out['content-length'];
        if (out.location && /^\/(?!\/)/.test(out.location)) out.location = prefix + out.location;
        if (ct.includes('text/html')) {
          // remember which port this browser is previewing, so absolute-path
          // fetches from its JS can be routed back (see fallback below)
          const sc = out['set-cookie'];
          const mine = `cc_proxy=${port}; Path=/; SameSite=Lax`;
          out['set-cookie'] = sc ? [].concat(sc, mine) : mine;
          const chunks = [];
          pres.on('data', c => chunks.push(c));
          pres.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            // rewrite absolute-root asset URLs first…
            html = html.replace(/(\b(?:href|src|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${prefix}/`)
                       .replace(/url\((['"]?)\/(?!\/)/gi, `url($1${prefix}/`);
            // …then inject <base> (after rewriting, so its own href isn't mangled)
            const baseTag = `<base href="${prefix}/">`;
            html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`) : baseTag + html;
            res.writeHead(pres.statusCode, out);
            res.end(html);
          });
        } else {
          res.writeHead(pres.statusCode, out);
          pres.pipe(res);
        }
      });
      preq.on('error', e => {
        if (canRetry && e.code === 'ECONNREFUSED') return attempt('::1', false);
        if (!res.headersSent) res.status(502).end('proxy error: ' + e.message);
      });
      preq.end(Buffer.concat(bodyChunks));
    };
    attempt('127.0.0.1', true);
  });
}

// Reverse-proxy a local dev server so the phone can view it: /proxy/<port>/...
// HTML gets a <base> tag + absolute-asset-path rewriting so relative & root-
// relative URLs resolve through the prefix. (WebSocket/HMR is not proxied.)
app.use('/proxy', (req, res) => {
  const m = /^\/(\d{1,5})(\/[\s\S]*)?$/.exec(req.url);
  if (!m) return res.status(400).end('usage: /proxy/<port>/path');
  const port = parseInt(m[1], 10);
  if (!port || port > 65535 || port === Number(PORT)) return res.status(400).end('bad port');
  if (!seenPorts.has(port)) {
    audit('proxy_denied', { ip: reqIp(req), port });
    return res.status(403).end('port not referenced by any session (set CC_PROXY_ALLOW to override)');
  }
  forwardToPort(port, m[2] || '/', req, res);
});

// ── Proxy fallback (must stay the LAST route) ──
// JS inside a proxied page can't be path-rewritten, so its absolute requests
// (fetch('/api/x'), import '/src/y.js') land on OUR origin. If the request's
// Referer (or the cc_proxy cookie set when the proxied HTML was served) says
// the browser is previewing /proxy/<port>/, forward it there transparently.
// Our own routes always win — they matched earlier.
app.use((req, res) => {
  let port = null;
  const r = /\/proxy\/(\d{1,5})\//.exec(req.headers.referer || '');
  if (r) port = parseInt(r[1], 10);
  if (!port) {
    const c = /(?:^|;\s*)cc_proxy=(\d{1,5})/.exec(req.headers.cookie || '');
    if (c) port = parseInt(c[1], 10);
  }
  if (port && port !== Number(PORT) && seenPorts.has(port)) {
    return forwardToPort(port, req.originalUrl, req, res);
  }
  res.status(404).end('not found');
});

// Pure, dependency-free helpers are exported for unit tests. Requiring this
// module must NOT start the server or any timers — hence the boot guard below.
module.exports = { cwdToProjectDir, isTempCwd, truncStr, tokenOk, renderable, slim, buildSpawnArgs };

// ── Boot (only when run directly, not when require()d by a test) ──
if (require.main === module) {
  sweepUploads();
  setInterval(sweepUploads, 6 * 3600 * 1000);

  // Clean up per-spawn MCP configs left behind by a crash.
  try {
    for (const f of fs.readdirSync(__dirname)) {
      if (/^\.mcp-perm-.*\.json$/.test(f) || f === '.mcp-permission.json') fs.unlinkSync(path.join(__dirname, f));
    }
  } catch {}

  watchSessions();

  server.listen(PORT, () => {
    console.log(`PocketClaude server → http://localhost:${PORT}`);
    console.log(`login key:   ${AUTH_TOKEN}`);
    console.log(`claude CLI:  ${CLAUDE_PATH}`);
    console.log(`cowork dir:  ${fs.existsSync(COWORK_DIR) ? COWORK_DIR : '(none — Cowork not installed)'}`);
    console.log(`Tunnel: npx cloudflared tunnel --url http://localhost:${PORT}`);
  });
}
