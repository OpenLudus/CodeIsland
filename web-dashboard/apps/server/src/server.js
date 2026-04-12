const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 3456;
const MAX_EVENTS = 1000;
const LOG_DIR = process.env.DASHBOARD_LOG_DIR || path.join(os.tmpdir(), 'openludus-dashboard-runs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// In-memory state
const events = [];
const pendingDecisions = {}; // eventId -> { resolved: bool, decision: null | object }
const sseClients = [];

// MIME types for static files
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function broadcast(event) {
  const data = JSON.stringify(event);
  const msg = `event: hook\ndata: ${data}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(msg);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

// Determine if an event is blocking (needs a decision before hook.sh can return)
// Infer agent source from event fields
function inferSource(evt) {
  if (evt._source) return evt._source;
  const tp = evt.transcript_path || '';
  if (tp.includes('/.hermes/')) return 'hermes';
  if (tp.includes('/.factory/')) return 'factory';
  if (tp.includes('/.codex/')) return 'codex';
  if (tp.includes('/.gemini/')) return 'gemini';
  if (tp.includes('/.cursor/')) return 'cursor';
  if (tp.includes('/.copilot/')) return 'copilot';
  if (tp.includes('/.qoder/')) return 'qoder';
  if (tp.includes('/.codebuddy/')) return 'codebuddy';
  if (tp.includes('/.openclaw/')) return 'openclaw';
  if (tp.includes('/.local/share/opencode')) return 'opencode';
  if (tp.includes('/.claude/')) return 'claude';
  return 'unknown';
}

function isBlocking(evt) {
  if (evt.hook_event_name === 'PermissionRequest') return true;
  if (evt.hook_event_name === 'Notification' && evt.question) return true;
  if (evt.hook_event_name === 'Elicitation') return true;
  return false;
}

// --- Session aggregation ---
// Derive a session list from the raw event log. Groups events by session_id
// and computes per-session metadata used by the sidebar.
function getSessions() {
  const bySession = {};
  for (const evt of events) {
    const sid = evt.session_id;
    if (!sid) continue;
    let s = bySession[sid];
    if (!s) {
      s = bySession[sid] = {
        session_id: sid,
        _agent: evt._agent || 'unknown',
        cwd: null,
        model: null,
        firstSeen: evt.receivedAt,
        lastSeen: evt.receivedAt,
        lastEventName: evt.hook_event_name,
        lastContent: '',
        eventCount: 0,
        hasBlocking: false,
        status: 'running',
      };
    }
    s.eventCount++;
    if (evt._agent && evt._agent !== 'unknown') s._agent = evt._agent;
    if (evt.cwd && !s.cwd) s.cwd = evt.cwd;
    if (evt.tool_input?.cwd && !s.cwd) s.cwd = evt.tool_input.cwd;
    if (evt.model && !s.model) s.model = evt.model;
    if (new Date(evt.receivedAt) >= new Date(s.lastSeen)) {
      s.lastSeen = evt.receivedAt;
      s.lastEventName = evt.hook_event_name;
    }
    if (evt.hook_event_name === 'UserPromptSubmit' && evt.prompt) s.lastContent = evt.prompt;
    if (evt.hook_event_name === 'Stop' && evt.last_assistant_message) s.lastContent = evt.last_assistant_message;
    if (evt.isBlocking && !evt.decided) s.hasBlocking = true;
  }
  const TERMINAL_EVENTS = new Set(['Stop', 'StopFailure', 'SessionEnd']);
  const list = Object.values(bySession);
  for (const s of list) {
    if (s.hasBlocking) s.status = 'blocked';
    else if (TERMINAL_EVENTS.has(s.lastEventName)) s.status = 'idle';
    else s.status = 'running';
  }
  list.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  return list;
}

// --- Agent spawn registry ---
// Whitelist of runnable agents. Keeps spawn surface tight: caller supplies
// agent name + prompt + cwd; server builds the argv from this table.
//
// Claude permission story under root:
// - --dangerously-skip-permissions is rejected by Claude when uid=0 (root),
//   which is common on servers, so we can't use it.
// - In `claude -p` (print mode), the default permission resolver auto-DENIES
//   any tool that would normally prompt — and crucially it does NOT fire the
//   PermissionRequest hook in print mode, so our dashboard never sees them.
// - Workaround: pre-whitelist common safe tools via --allowedTools. The flag
//   syntax requires the prompt as a positional BEFORE the flag (otherwise the
//   variadic --allowedTools eats the prompt).
const CLAUDE_DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];
const AGENT_SPAWNERS = {
  claude: (prompt) => ({
    cmd: 'claude',
    args: ['-p', prompt, '--allowedTools', ...CLAUDE_DEFAULT_ALLOWED_TOOLS],
  }),
  codex:  (prompt) => ({ cmd: 'codex',  args: ['exec', prompt, '--dangerously-bypass-approvals-and-sandbox'] }),
  opencode: (prompt) => ({ cmd: 'opencode-dashboard', args: [prompt] }),
  openclaw: (prompt) => ({ cmd: 'openclaw-dashboard', args: [prompt] }),
};

// Resume registry — agents that can continue an existing session by id.
// Claude Code is the only one with stable native support today: each invocation
// of `claude -p --resume <id>` re-loads the JSONL transcript on disk and emits
// hook events under the same session_id, so the dashboard naturally clusters
// the new turn with the old one. OpenCode and Codex would need wrapper changes
// to honor a passed-in session id.
const RESUME_SPAWNERS = {
  claude: (sessionId, prompt) => ({
    cmd: 'claude',
    args: ['-p', prompt, '--resume', sessionId, '--allowedTools', ...CLAUDE_DEFAULT_ALLOWED_TOOLS],
  }),
};

function spawnDetached({ cmd, args, cwd, label }) {
  const runId = crypto.randomUUID().slice(0, 8);
  const logPath = path.join(LOG_DIR, `${label}-${runId}.log`);
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, CLAUDE_DASHBOARD_URL: `http://localhost:${PORT}` },
  });
  child.unref();
  return { pid: child.pid, logPath, runId, cmd, args, cwd };
}

function spawnAgent({ agent, prompt, cwd }) {
  const builder = AGENT_SPAWNERS[agent];
  if (!builder) throw new Error(`unknown agent: ${agent}`);
  if (!prompt || typeof prompt !== 'string') throw new Error('missing prompt');
  const workDir = (cwd && typeof cwd === 'string' && cwd.length > 0) ? cwd : (process.env.HOME || '/tmp');
  const { cmd, args } = builder(prompt);
  return spawnDetached({ cmd, args, cwd: workDir, label: agent });
}

// Look up the cwd + agent for a session id from the in-memory event log.
// Used by /api/sessions/:id/message to know how to spawn the resume call.
function findSessionMeta(sessionId) {
  const sessionEvents = events.filter((e) => e.session_id === sessionId);
  if (sessionEvents.length === 0) return null;
  let cwd = null;
  let agent = 'unknown';
  for (const e of sessionEvents) {
    if (e._agent && e._agent !== 'unknown') agent = e._agent;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!cwd && e.tool_input?.cwd) cwd = e.tool_input.cwd;
  }
  return { agent, cwd: cwd || process.env.HOME || '/tmp' };
}

function resumeSession({ session_id, prompt }) {
  if (!session_id) throw new Error('missing session_id');
  if (!prompt || typeof prompt !== 'string') throw new Error('missing prompt');
  const meta = findSessionMeta(session_id);
  if (!meta) throw new Error(`unknown session: ${session_id}`);
  const builder = RESUME_SPAWNERS[meta.agent];
  if (!builder) throw new Error(`resume not supported for agent: ${meta.agent}`);
  const { cmd, args } = builder(session_id, prompt);
  return spawnDetached({ cmd, args, cwd: meta.cwd, label: `${meta.agent}-resume` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // --- API Routes ---

  // POST /api/events — receive hook event
  if (req.method === 'POST' && pathname === '/api/events') {
    try {
      const body = await readBody(req);
      const evt = JSON.parse(body);
      const eventId = crypto.randomUUID();
      const record = {
        eventId,
        receivedAt: new Date().toISOString(),
        isBlocking: isBlocking(evt),
        decided: false,
        decision: null,
        ...evt,
        _agent: inferSource(evt),
      };
      events.push(record);
      if (events.length > MAX_EVENTS) {
        const evicted = events.splice(0, events.length - MAX_EVENTS);
        for (const e of evicted) delete pendingDecisions[e.eventId];
      }

      if (record.isBlocking) {
        pendingDecisions[eventId] = { resolved: false, decision: null };
      }

      broadcast(record);
      json(res, 200, { eventId });
    } catch (e) {
      json(res, 400, { error: 'Invalid JSON' });
    }
    return;
  }

  // GET /api/events — return all stored events
  if (req.method === 'GET' && pathname === '/api/events') {
    json(res, 200, events);
    return;
  }

  // GET /api/sessions — grouped session list derived from events
  if (req.method === 'GET' && pathname === '/api/sessions') {
    json(res, 200, getSessions());
    return;
  }

  // POST /api/sessions/new — spawn a new agent session with an initial prompt
  if (req.method === 'POST' && pathname === '/api/sessions/new') {
    try {
      const body = await readBody(req);
      const { agent, prompt, cwd } = JSON.parse(body);
      const info = spawnAgent({ agent, prompt, cwd });
      json(res, 200, { ok: true, ...info });
    } catch (e) {
      json(res, 400, { error: String(e.message || e) });
    }
    return;
  }

  // POST /api/sessions/:id/message — continue an existing session via --resume
  const resumeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
  if (req.method === 'POST' && resumeMatch) {
    const sessionId = decodeURIComponent(resumeMatch[1]);
    try {
      const body = await readBody(req);
      const { prompt } = JSON.parse(body);
      const info = resumeSession({ session_id: sessionId, prompt });
      json(res, 200, { ok: true, ...info });
    } catch (e) {
      json(res, 400, { error: String(e.message || e) });
    }
    return;
  }

  // GET /api/agents — list whitelisted spawnable agents
  if (req.method === 'GET' && pathname === '/api/agents') {
    json(res, 200, Object.keys(AGENT_SPAWNERS));
    return;
  }

  // GET /api/events/stream — SSE
  if (req.method === 'GET' && pathname === '/api/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // Send all existing events as init batch
    res.write(`event: init\ndata: ${JSON.stringify(events)}\n\n`);
    sseClients.push(res);

    // Keepalive every 15s
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
    return;
  }

  // GET /api/decisions/:eventId — poll for decision
  const pollMatch = pathname.match(/^\/api\/decisions\/([^/]+)$/);
  if (req.method === 'GET' && pollMatch) {
    const eventId = pollMatch[1];
    const pending = pendingDecisions[eventId];
    if (!pending || !pending.resolved) {
      json(res, 200, {});
    } else {
      json(res, 200, pending.decision);
    }
    return;
  }

  // POST /api/decisions/:eventId — submit decision
  if (req.method === 'POST' && pollMatch) {
    const eventId = pollMatch[1];
    try {
      const body = await readBody(req);
      const decision = JSON.parse(body);
      if (pendingDecisions[eventId]) {
        pendingDecisions[eventId].resolved = true;
        pendingDecisions[eventId].decision = decision;
      }
      // Update the event record
      const evt = events.find((e) => e.eventId === eventId);
      if (evt) {
        evt.decided = true;
        evt.decision = decision;
        broadcast({ ...evt, _decisionUpdate: true });
      }
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
    }
    return;
  }

  // --- Static Files ---
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.join(__dirname, '..', 'public', filePath);
  const ext = path.extname(fullPath);

  try {
    const content = fs.readFileSync(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Hook Dashboard running at http://0.0.0.0:${PORT}`);
});
