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
function setAuthCookie(req, res) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `cc_auth=${encodeURIComponent(AUTH_TOKEN)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
}

const app = express();
app.use(express.json());

// The shell (no secrets) loads without auth so the login screen can render;
// every other route — API, WS, /media, /proxy, /uploads — requires the token.
const PUBLIC_PATHS = new Set(['/', '/index.html', '/manifest.json', '/sw.js', '/icon.svg', '/auth']);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (tokenOk(reqToken(req))) return next();
  res.status(401).json({ error: 'unauthorized' });
});
app.use(express.static(path.join(__dirname, 'public')));

// Exchange the shared secret for the auth cookie (so media/proxy URLs work
// without ?token= on every link).
app.post('/auth', (req, res) => {
  const t = (req.body && req.body.token) || reqToken(req);
  if (!tokenOk(t)) return res.status(401).json({ error: 'bad token' });
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
let activeClaudeProcess = null;
let activeSpawnSessionId = null;   // which session the running spawn belongs to (routes permission prompts)

// Kill the whole process tree — on Windows, proc.kill() leaves claude's
// children (node subprocesses, shells) running.
function killActive() {
  const p = activeClaudeProcess;
  if (!p) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore' }); } catch { try { p.kill(); } catch {} }
  } else {
    try { p.kill(); } catch {}
  }
}

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

// MCP config for the interactive permission-prompt tool (written once at startup).
const MCP_CONFIG_PATH = path.join(__dirname, '.mcp-permission.json');
try {
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({
    mcpServers: { ccperm: { type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'mcp-permission.js')], env: { CC_PORT: String(PORT), CC_TOKEN: AUTH_TOKEN } } },
  }));
} catch {}

// Pending interactive permission prompts: id -> { res, timer }
const pendingPerms = new Map();
let permSeq = 0;

// --- Spawn / resume Claude session ---
function startClaude(cwd, prompt, resumeSessionId, permissionMode, model, effort) {
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

  // One spawn at a time — refuse loudly instead of silently killing the
  // other session's running task (which is what the old code did).
  if (activeClaudeProcess) {
    broadcast({ type: 'spawn_blocked', sessionId: resumeSessionId, reasonKey: 'blocked_busy',
      reason: '已有另一個任務進行中，請先按「停止」或等它完成。' });
    return;
  }

  const args = ['--output-format', 'stream-json', '--verbose'];
  if (permissionMode === 'interactive') {
    // route every permission decision to the phone via our MCP approve tool
    args.push('--permission-mode', 'default', '--mcp-config', MCP_CONFIG_PATH, '--permission-prompt-tool', 'mcp__ccperm__approve');
  } else if (permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');           // canonical flag, all versions
  } else if (permissionMode && PERM_MODES.has(permissionMode)) {
    args.push('--permission-mode', permissionMode);
  }
  if (model && MODELS.has(model)) args.push('--model', model);
  if (effort && EFFORTS.has(effort)) args.push('--effort', effort);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  args.push('--print', prompt);

  // Use cwd from tailed session if resuming
  const effectiveCwd = cwd || (resumeSessionId && tailedSessions.get(resumeSessionId)?.cwd) || process.cwd();
  const proc = spawn(CLAUDE_PATH, args, { cwd: effectiveCwd, env: process.env });
  activeClaudeProcess = proc;
  activeSpawnSessionId = resumeSessionId || null;
  broadcast({ type: 'spawn_start', cwd: effectiveCwd, resumeSessionId });

  proc.stdout.on('data', chunk => {
    // When resuming, JSONL file watcher already picks up new events — skip stdout to avoid duplicates
    if (resumeSessionId) return;
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      try { broadcast({ type: 'spawn_event', event: JSON.parse(line) }); }
      catch { broadcast({ type: 'spawn_raw', text: line }); }
    }
  });
  proc.stderr.on('data', chunk => broadcast({ type: 'spawn_stderr', text: chunk.toString() }));
  proc.on('close', code => {
    activeClaudeProcess = null;
    activeSpawnSessionId = null;
    broadcast({ type: 'spawn_end', code, resumeSessionId });
    const s = resumeSessionId && tailedSessions.get(resumeSessionId);
    sendPush('done', s ? path.basename(s.cwd || '') : '');
  });
}

// WebSocket — the upgrade request carries the cc_auth cookie (same-origin) or
// a ?token= fallback; reject anything else before it can see session data.
wss.on('connection', (ws, req) => {
  if (!tokenOk(reqToken(req))) { ws.close(4401, 'unauthorized'); return; }
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
  ws.send(JSON.stringify({ type: 'init', sessions, spawnRunning: !!activeClaudeProcess }));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'send') startClaude(msg.cwd, msg.text, msg.resumeSessionId, msg.permissionMode, msg.model, msg.effort);
    else if (msg.type === 'stop' && activeClaudeProcess) killActive();
    else if (msg.type === 'get_history') {
      const s = tailedSessions.get(msg.sessionId);
      // last 300 renderable events is plenty for a phone screen; a full history
      // can be thousands of events / tens of MB and freezes the client
      ws.send(JSON.stringify({ type: 'history', sessionId: msg.sessionId, history: (s?.history || []).slice(-300) }));
    }
    else if (msg.type === 'permission_decision') {
      const p = pendingPerms.get(msg.id);
      if (p) {
        clearTimeout(p.timer); pendingPerms.delete(msg.id);
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
app.post('/run', (req, res) => {
  if (!req.body.prompt) return res.status(400).json({ error: 'prompt required' });
  startClaude(req.body.cwd, req.body.prompt);
  res.json({ ok: true });
});
app.post('/stop', (_, res) => { killActive(); res.json({ ok: true }); });
app.get('/status', (_, res) => res.json({
  spawnRunning: !!activeClaudeProcess,
  sessions: [...tailedSessions.keys()],
}));

// The MCP permission tool calls this; we ask the phone and hold the response
// until the user decides (or a timeout auto-denies so the agent never hangs).
app.post('/mcp-permission', (req, res) => {
  const { tool_name, input } = req.body || {};
  const id = 'perm' + (++permSeq);
  const timer = setTimeout(() => {
    if (pendingPerms.has(id)) {
      pendingPerms.delete(id);
      res.json({ behavior: 'deny', message: '逾時未回應' });
      broadcast({ type: 'permission_resolved', id, behavior: 'timeout' });
    }
  }, 120000);
  pendingPerms.set(id, { res, timer });
  broadcast({ type: 'permission_request', id, sessionId: activeSpawnSessionId, toolName: tool_name || 'tool', input: input || {} });
  sendPush('perm', tool_name || 'tool');
});

// Reverse-proxy a local dev server so the phone can view it: /proxy/<port>/...
// HTML gets a <base> tag + absolute-asset-path rewriting so relative & root-
// relative URLs resolve through the prefix. (WebSocket/HMR is not proxied.)
app.use('/proxy', (req, res) => {
  const m = /^\/(\d{1,5})(\/[\s\S]*)?$/.exec(req.url);
  if (!m) return res.status(400).end('usage: /proxy/<port>/path');
  const port = parseInt(m[1], 10);
  if (!port || port > 65535 || port === Number(PORT)) return res.status(400).end('bad port');
  const subPath = m[2] || '/';
  const prefix = '/proxy/' + port;
  const headers = { ...req.headers, host: '127.0.0.1:' + port, 'accept-encoding': 'identity' };
  delete headers['if-none-match']; delete headers['if-modified-since'];
  const preq = http.request({ host: '127.0.0.1', port, path: subPath, method: req.method, headers }, pres => {
    const ct = pres.headers['content-type'] || '';
    const out = { ...pres.headers };
    delete out['content-length'];
    if (out.location && /^\/(?!\/)/.test(out.location)) out.location = prefix + out.location;
    if (ct.includes('text/html')) {
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
  preq.on('error', e => { if (!res.headersSent) res.status(502).end('proxy error: ' + e.message); });
  req.pipe(preq);
});

watchSessions();

server.listen(PORT, () => {
  console.log(`PocketClaude server → http://localhost:${PORT}`);
  console.log(`login key:   ${AUTH_TOKEN}`);
  console.log(`claude CLI:  ${CLAUDE_PATH}`);
  console.log(`cowork dir:  ${fs.existsSync(COWORK_DIR) ? COWORK_DIR : '(none — Cowork not installed)'}`);
  console.log(`Tunnel: npx cloudflared tunnel --url http://localhost:${PORT}`);
});
