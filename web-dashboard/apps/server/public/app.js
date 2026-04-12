const feed = document.getElementById('event-feed');
const countEl = document.getElementById('event-count');
const statusDot = document.getElementById('connection-status');
const statusLabel = document.getElementById('connection-label');

let totalEvents = 0;
const seenIds = new Set();
const allEvents = []; // store all events for detail view

const CIRCLE = '\u23FA';
const AGENT_NAMES = {
  claude: 'Claude', codex: 'Codex', factory: 'Factory', hermes: 'Hermes',
  gemini: 'Gemini', cursor: 'Cursor', copilot: 'Copilot',
  qoder: 'Qoder', codebuddy: 'CodeBuddy', openclaw: 'OpenClaw', opencode: 'OpenCode', unknown: '?',
};

function statusClass(evt) {
  const n = evt.hook_event_name;
  if (n === 'PostToolUseFailure' || n === 'StopFailure' || n === 'PermissionDenied') return 'error';
  if (n === 'PostToolUse') return 'success';
  if (n === 'PreToolUse') return 'pending';
  if (n === 'PermissionRequest') return evt.decided ? 'success' : 'pending';
  if (n === 'SessionStart') return 'success';
  if (n === 'SessionEnd' || n === 'Stop') return 'dim';
  if (n === 'UserPromptSubmit') return 'info';
  if (n === 'SubagentStart' || n === 'SubagentStop') return 'info';
  return 'dim';
}

// --- SSE ---
function connect() {
  const es = new EventSource('/api/events/stream');
  es.addEventListener('init', (e) => {
    JSON.parse(e.data).reverse().forEach(renderEvent);
  });
  es.addEventListener('hook', (e) => {
    const event = JSON.parse(e.data);
    event._decisionUpdate ? updateDecision(event) : renderEvent(event);
  });
  es.onopen = () => { statusDot.className = 'status-dot connected'; statusLabel.textContent = 'Connected'; };
  es.onerror = () => { statusDot.className = 'status-dot disconnected'; statusLabel.textContent = 'Reconnecting...'; };
}

// --- Render ---
function renderEvent(evt) {
  if (seenIds.has(evt.eventId)) return;
  seenIds.add(evt.eventId);
  allEvents.push(evt);

  const empty = feed.querySelector('.empty-state');
  if (empty) empty.remove();

  const card = document.createElement('div');
  card.className = 'event-card' + (evt.isBlocking && !evt.decided ? ' blocking' : '') + (evt.decided ? ' decided' : '');
  card.id = 'evt-' + evt.eventId;
  card.dataset.eventId = evt.eventId;

  const time = new Date(evt.receivedAt).toLocaleTimeString();
  const sessionShort = (evt.session_id || '').substring(0, 8);
  const eventName = evt.hook_event_name || 'Unknown';
  const agent = evt._agent || 'unknown';
  const agentLabel = AGENT_NAMES[agent] || agent;
  const sc = statusClass(evt);

  // Compact summary line
  const summary = buildSummary(evt, eventName);

  card.innerHTML = `
    <div class="card-row" onclick="toggleExpand('${evt.eventId}')">
      <span class="status-indicator ${sc}">${CIRCLE}</span>
      <span class="agent-badge agent-${agent}">${esc(agentLabel)}</span>
      <span class="event-badge">${esc(eventName)}</span>
      <span class="card-summary">${summary}</span>
      <span class="card-session">${esc(sessionShort)}</span>
      <span class="card-time">${time}</span>
      <span class="expand-arrow">&#x25B6;</span>
    </div>
    <div class="card-detail" id="detail-${evt.eventId}" style="display:none">
      ${buildDetail(evt, eventName)}
    </div>
  `;

  feed.prepend(card);
  totalEvents++;
  countEl.textContent = totalEvents + ' events';
}

// One-line summary for the collapsed row
function buildSummary(evt, eventName) {
  if (evt.tool_name) {
    const desc = toolDescription(evt);
    const toolSpan = evt._gateway_response
      ? `<span class="sum-tool gateway-reply">${esc(evt.tool_name)} ↩ gateway reply</span>`
      : `<span class="sum-tool">${esc(evt.tool_name)}</span>`;
    return toolSpan + (desc ? `<span class="sum-desc">${esc(truncate(desc, 80))}</span>` : '');
  }
  if (eventName === 'UserPromptSubmit' && evt.prompt)
    return `<span class="sum-prompt">${esc(truncate(evt.prompt, 100))}</span>`;
  if ((eventName === 'Stop' || eventName === 'StopFailure') && evt.last_assistant_message)
    return `<span class="sum-desc">${esc(truncate(evt.last_assistant_message, 100))}</span>`;
  if (eventName === 'SessionStart') {
    const parts = [evt.source, evt.model].filter(Boolean);
    return parts.length ? `<span class="sum-desc">${esc(parts.join(' · '))}</span>` : '';
  }
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop')
    return evt.agent_type ? `<span class="sum-desc">${esc(evt.agent_type)}</span>` : '';
  if (eventName === 'Notification' && evt.message)
    return `<span class="sum-desc">${esc(truncate(evt.message, 80))}</span>`;
  if (eventName === 'FileChanged')
    return `<span class="sum-desc">${esc(evt.event || '')} ${esc(evt.file_path || '')}</span>`;
  return '';
}

// Full expanded detail
function buildDetail(evt, eventName) {
  let html = '';

  // Gateway reply banner — send_message tool with full content
  if (evt._gateway_response && evt._gateway_message) {
    const platform = evt._gateway_platform ? `[${esc(evt._gateway_platform)}] ` : '';
    const target = evt._gateway_target ? `→ ${esc(evt._gateway_target)}` : '';
    html += `<div class="detail-section">
      <div class="detail-label">↩ Gateway Reply ${platform}${target}</div>
      <div class="assistant-msg gateway-msg">${esc(evt._gateway_message)}</div>
    </div>`;
  }

  // Tool input
  if (evt.tool_input && Object.keys(evt.tool_input).length > 0) {
    html += `<div class="detail-section">
      <div class="detail-label">Input</div>
      <div class="detail-json">${esc(JSON.stringify(evt.tool_input, null, 2))}</div>
    </div>`;
  }

  // Tool response (PostToolUse)
  if (evt.tool_response) {
    let resp = evt.tool_response;
    if (typeof resp === 'string') {
      try { resp = JSON.parse(resp); } catch {}
    }
    const formatted = typeof resp === 'object' ? JSON.stringify(resp, null, 2) : String(resp);
    html += `<div class="detail-section">
      <div class="detail-label">Output</div>
      <div class="detail-json output">${esc(formatted)}</div>
    </div>`;
  }

  // Error
  if (evt.error) {
    html += `<div class="detail-section">
      <div class="detail-label">Error</div>
      <div class="detail-json error-block">${esc(evt.error)}</div>
    </div>`;
  }

  // User prompt (full)
  if (eventName === 'UserPromptSubmit' && evt.prompt) {
    html += `<div class="detail-section">
      <div class="detail-label">Prompt</div>
      <div class="user-prompt-text">${esc(evt.prompt)}</div>
    </div>`;
  }

  // Last assistant message
  if (evt.last_assistant_message) {
    html += `<div class="detail-section">
      <div class="detail-label">Assistant Response</div>
      <div class="assistant-msg">${esc(evt.last_assistant_message)}</div>
    </div>`;
  }

  // Subagent
  if (evt.agent_type) {
    html += `<div class="detail-section"><div class="detail-label">Agent Type</div><div class="subagent-info">${esc(evt.agent_type)}</div></div>`;
  }
  if (evt.agent_id) {
    html += `<div class="detail-section"><div class="detail-label">Agent ID</div><div class="lifecycle-info">${esc(evt.agent_id)}</div></div>`;
  }

  // Permission reason
  if (evt.reason) {
    html += `<div class="detail-section"><div class="detail-label">Reason</div><div class="lifecycle-info">${esc(evt.reason)}</div></div>`;
  }

  // Decision UI (blocking events) — Paseo-aligned layout
  if (evt.isBlocking && !evt.decided) {
    if (eventName === 'PermissionRequest') {
      // Title + description + tool detail + "How would you like to proceed?" + Deny/Allow buttons
      const permTitle = evt.tool_name ? evt.tool_name : 'Permission Required';
      const permDesc  = evt.reason || '';
      html += `<div class="decision-block" id="decision-${evt.eventId}">
        <div class="decision-title">${esc(permTitle)}</div>
        ${permDesc ? `<div class="decision-desc">${esc(permDesc)}</div>` : ''}
        <div class="question-hint">How would you like to proceed?</div>
        <div class="decision-actions">
          <button class="btn btn-deny"  onclick="event.stopPropagation();decide('${evt.eventId}','deny',this)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9M3 3l6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Deny
          </button>
          <button class="btn btn-allow" onclick="event.stopPropagation();decide('${evt.eventId}','allow',this)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Allow
          </button>
        </div>
      </div>`;

    } else if (eventName === 'Notification' && evt.question) {
      html += `<div class="decision-block" id="decision-${evt.eventId}">
        <div class="question-text">${esc(evt.question)}</div>`;
      if (evt.options && evt.options.length > 0) {
        html += `<div class="options-list">`;
        evt.options.forEach((opt) => {
          html += `<div class="option-item" onclick="event.stopPropagation();answerOption('${evt.eventId}',${JSON.stringify(opt)},this)">
            <span class="option-label">${esc(opt)}</span>
            <span class="option-check">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </div>`;
        });
        html += `</div>`;
      } else {
        html += `<div class="decision-actions">
          <input type="text" id="input-${evt.eventId}" placeholder="Type answer…" class="text-input" onclick="event.stopPropagation()" onkeydown="if(event.key==='Enter')answerText('${evt.eventId}')">
          <button class="btn btn-allow" onclick="event.stopPropagation();answerText('${evt.eventId}')">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Submit
          </button>
          <button class="btn btn-deny" onclick="event.stopPropagation();dismissNotification('${evt.eventId}',this)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9M3 3l6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Dismiss
          </button>
        </div>`;
      }
      html += `</div>`;

    } else if (eventName === 'Elicitation') {
      html += `<div class="decision-block" id="decision-${evt.eventId}">`;
      if (evt.message) html += `<div class="question-text">${esc(evt.message)}</div>`;
      if (evt.options && evt.options.length > 0) {
        html += `<div class="options-list">`;
        evt.options.forEach((opt) => {
          html += `<div class="option-item" onclick="event.stopPropagation();elicitOption('${evt.eventId}',${JSON.stringify(opt)},this)">
            <span class="option-label">${esc(opt)}</span>
            <span class="option-check">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </div>`;
        });
        html += `</div>`;
        html += `<div class="decision-actions">
          <button class="btn btn-deny" onclick="event.stopPropagation();elicitReject('${evt.eventId}',this)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9M3 3l6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Dismiss
          </button>
        </div>`;
      } else {
        html += `<div class="decision-actions">
          <input type="text" id="input-${evt.eventId}" placeholder="Type response…" class="text-input" onclick="event.stopPropagation()" onkeydown="if(event.key==='Enter')elicitAcceptText('${evt.eventId}')">
          <button class="btn btn-allow" onclick="event.stopPropagation();elicitAcceptText('${evt.eventId}')">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Accept
          </button>
          <button class="btn btn-deny" onclick="event.stopPropagation();elicitReject('${evt.eventId}',this)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9M3 3l6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Dismiss
          </button>
        </div>`;
      }
      html += `</div>`;
    }
  } else if (evt.isBlocking && evt.decided) {
    html += decisionLabel(evt);
  }

  // Raw JSON button
  html += `<button class="toggle-btn" onclick="event.stopPropagation();showRaw('${evt.eventId}')" style="margin-top:8px">View raw JSON</button>`;

  // Related events in same session
  const related = allEvents.filter(e => e.session_id === evt.session_id && e.eventId !== evt.eventId);
  if (related.length > 0) {
    html += `<div class="detail-section" style="margin-top:12px">
      <div class="detail-label">Session timeline (${related.length + 1} events)</div>
      <div class="timeline">`;
    // Show all events in this session in chronological order
    const sessionEvts = [evt, ...related].sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
    for (const se of sessionEvts) {
      const isCurrent = se.eventId === evt.eventId;
      const t = new Date(se.receivedAt).toLocaleTimeString();
      const tool = se.tool_name ? ` [${se.tool_name}]` : '';
      html += `<div class="timeline-item${isCurrent ? ' current' : ''}" onclick="event.stopPropagation();scrollToEvent('${se.eventId}')">
        <span class="status-indicator ${statusClass(se)}" style="font-size:8px">${CIRCLE}</span>
        <span class="tl-time">${t}</span>
        <span class="tl-name">${esc(se.hook_event_name)}${esc(tool)}</span>
      </div>`;
    }
    html += `</div></div>`;
  }

  return html || '<div class="lifecycle-info">No additional details</div>';
}

// --- Toggle expand/collapse ---
function toggleExpand(eventId) {
  const detail = document.getElementById('detail-' + eventId);
  const card = document.getElementById('evt-' + eventId);
  const arrow = card.querySelector('.expand-arrow');
  if (detail.style.display === 'none') {
    detail.style.display = 'block';
    card.classList.add('expanded');
    arrow.innerHTML = '&#x25BC;';
  } else {
    detail.style.display = 'none';
    card.classList.remove('expanded');
    arrow.innerHTML = '&#x25B6;';
  }
}

function scrollToEvent(eventId) {
  const card = document.getElementById('evt-' + eventId);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('highlight');
  setTimeout(() => card.classList.remove('highlight'), 1500);
  // Auto-expand
  const detail = document.getElementById('detail-' + eventId);
  if (detail && detail.style.display === 'none') toggleExpand(eventId);
}

// --- Raw JSON overlay ---
function showRaw(eventId) {
  const evt = allEvents.find(e => e.eventId === eventId);
  if (!evt) return;
  const overlay = document.getElementById('overlay');
  const content = document.getElementById('overlay-content');
  content.textContent = JSON.stringify(evt, null, 2);
  overlay.style.display = 'flex';
}

function hideOverlay() {
  document.getElementById('overlay').style.display = 'none';
}

// --- Decision helpers ---
function blockDecision(eventId, triggerEl) {
  const block = document.getElementById('decision-' + eventId);
  if (!block) return;
  block.querySelectorAll('button').forEach(b => {
    b.disabled = true;
    if (b === triggerEl) { b.innerHTML = ''; b.classList.add('btn-loading'); }
  });
  block.querySelectorAll('.option-item').forEach(o => o.classList.add('loading'));
}

function updateDecision(evt) {
  const card = document.getElementById('evt-' + evt.eventId);
  if (!card) return;
  card.classList.add('decided');
  card.classList.remove('blocking');
  const dot = card.querySelector('.status-indicator');
  if (dot) dot.className = 'status-indicator success';
  const block = document.getElementById('decision-' + evt.eventId);
  if (block) block.outerHTML = decisionLabel(evt);
}

function decisionLabel(evt) {
  const checkSvg = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const xSvg     = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9M3 3l6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  if (evt.hook_event_name === 'PermissionRequest') {
    const behavior = evt.decision?.hookSpecificOutput?.decision?.behavior || 'unknown';
    if (behavior === 'allow') return `<span class="decision-label decision-allowed">${checkSvg} Allowed</span>`;
    return `<span class="decision-label decision-denied">${xSvg} Denied</span>`;
  }
  return `<span class="decision-label decision-answered">${checkSvg} Answered</span>`;
}

async function decide(eventId, behavior, btn) {
  blockDecision(eventId, btn);
  await fetch(`/api/decisions/${eventId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } }),
  });
}

async function dismissNotification(eventId, btn) {
  blockDecision(eventId, btn);
  await fetch(`/api/decisions/${eventId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Notification', answer: '' } }),
  });
}

async function answerOption(eventId, option, el) {
  el.classList.add('selected');
  blockDecision(eventId, null);
  await fetch(`/api/decisions/${eventId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Notification', answer: option } }),
  });
}

async function answerText(eventId) {
  const input = document.getElementById('input-' + eventId);
  if (!input || !input.value.trim()) return;
  const btn = input.nextElementSibling;
  blockDecision(eventId, btn);
  await fetch(`/api/decisions/${eventId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Notification', answer: input.value.trim() } }),
  });
}

async function elicitOption(eventId, result, el) {
  el.classList.add('selected');
  blockDecision(eventId, null);
  await fetch(`/api/decisions/${eventId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', result } }),
  });
}

async function elicitAcceptText(eventId) {
  const input = document.getElementById('input-' + eventId);
  if (!input || !input.value.trim()) return;
  const btn = input.nextElementSibling;
  blockDecision(eventId, btn);
  await fetch(`/api/decisions/${eventId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', result: input.value.trim() } }),
  });
}

async function elicitReject(eventId, btn) {
  blockDecision(eventId, btn);
  await fetch(`/api/decisions/${eventId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'reject' } }),
  });
}

// --- Helpers ---
function toolDescription(evt) {
  const input = evt.tool_input;
  if (!input) return null;
  switch (evt.tool_name) {
    case 'Bash': return input.description || input.command;
    case 'Read': return input.file_path;
    case 'Edit': case 'Write': return input.file_path;
    case 'Grep': return input.pattern + (input.path ? ' in ' + input.path : '');
    case 'Glob': return input.pattern;
    case 'WebSearch': return input.query;
    case 'WebFetch': return input.url;
    case 'Agent': return input.description || (input.prompt ? input.prompt.substring(0, 60) : null);
    case 'Execute': return input.command || input.file_path;
    default: return input.file_path || input.command || input.pattern || input.result || null;
  }
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function truncate(s, n) {
  return s.length > n ? s.substring(0, n) + '…' : s;
}

// --- Init ---
feed.innerHTML = `
  <div class="empty-state">
    <div class="logo">${CIRCLE}</div>
    <h2>Waiting for events…</h2>
    <p>Start a Claude Code session with hooks installed.</p>
  </div>
`;

connect();
