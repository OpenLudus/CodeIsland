const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3456;
const MAX_EVENTS = 1000;

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
