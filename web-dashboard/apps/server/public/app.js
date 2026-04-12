const feed = document.getElementById('event-feed');
const countEl = document.getElementById('event-count');
const statusDot = document.getElementById('connection-status');
const statusLabel = document.getElementById('connection-label');
const sessionListEl = document.getElementById('session-list');
const sessionCountEl = document.getElementById('session-count');
const sessionHeaderEl = document.getElementById('session-header');

let totalEvents = 0;
const seenIds = new Set();
const allEvents = []; // store all events for detail view
let currentSessionFilter = null; // null means "show all"
let sidebarRebuildQueued = false;

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
    // Process init events in CHRONOLOGICAL order so that:
    //  - tool row merging (PreToolUse → PostToolUse) sees Pre before Post
    //  - maybeInsertTurnSeparator's lookup for UserPromptSubmit always finds it
    //  - buildSessionMap's state machine replays forward correctly
    // Each renderEvent still prepends to the feed, so the final DOM order is
    // newest-on-top, which is what column-reverse needs to produce natural
    // chat order visually.
    JSON.parse(e.data).forEach(renderEvent);
  });
  es.addEventListener('hook', (e) => {
    const event = JSON.parse(e.data);
    event._decisionUpdate ? updateDecision(event) : renderEvent(event);
  });
  es.onopen = () => { statusDot.className = 'status-dot connected'; statusLabel.textContent = 'Connected'; };
  es.onerror = () => { statusDot.className = 'status-dot disconnected'; statusLabel.textContent = 'Reconnecting...'; };
}

// --- Render ---
// Tracks "open" PreToolUse rows keyed by session_id + tool_name + input hash so
// that a matching PostToolUse can update the same row in place instead of
// spawning a second card. CodexMonitor-like: one row per tool call.
const openToolRows = new Map();
function toolRowKey(evt) {
  return `${evt.session_id}|${evt.tool_name}|${JSON.stringify(evt.tool_input || {})}`;
}

// Top-level dispatcher: user/assistant "chat" messages get rendered as
// CodexMonitor-style bubbles, tool-call events get merged into compact
// "tool inline" rows, everything else stays as a minimal card row.
function renderEvent(evt) {
  if (seenIds.has(evt.eventId)) return;
  seenIds.add(evt.eventId);
  allEvents.push(evt);

  const empty = feed.querySelector('.empty-state');
  if (empty) empty.remove();

  const eventName = evt.hook_event_name || 'Unknown';

  if (eventName === 'UserPromptSubmit' && evt.prompt) {
    renderChatBubble(evt, 'user');
  } else if ((eventName === 'Stop' || eventName === 'StopFailure') && evt.last_assistant_message) {
    renderChatBubble(evt, 'assistant');
    maybeInsertTurnSeparator(evt);
  } else if (eventName === 'PreToolUse' && evt.tool_name) {
    renderToolRow(evt, 'running');
  } else if ((eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') && evt.tool_name) {
    // Try to find the matching open row and update it in place
    const key = toolRowKey(evt);
    const existing = openToolRows.get(key);
    if (existing) {
      updateToolRow(existing, evt, eventName === 'PostToolUseFailure' ? 'failed' : 'completed');
      openToolRows.delete(key);
    } else {
      // No matching PreToolUse — render as a complete row directly
      renderToolRow(evt, eventName === 'PostToolUseFailure' ? 'failed' : 'completed');
    }
  } else {
    renderCompactCard(evt);
  }

  totalEvents++;
  countEl.textContent = totalEvents + ' events';
  scheduleSidebarRebuild();
}

// Minimal CodexMonitor-style tool inline row: ● tool_name · argument
// No borders, no backgrounds. Just an icon, the tool name, and the value.
function renderToolRow(evt, status) {
  const card = document.createElement('div');
  card.className = 'event-card tool-row tool-row-' + status;
  card.id = 'evt-' + evt.eventId;
  card.dataset.eventId = evt.eventId;
  card.dataset.sessionId = evt.session_id || '';
  if (currentSessionFilter && card.dataset.sessionId !== currentSessionFilter) {
    card.style.display = 'none';
  }

  const value = toolDescription(evt) || '';

  card.innerHTML = `
    <div class="tool-row-line" onclick="toggleExpand('${evt.eventId}')">
      <span class="tool-row-icon"></span>
      <span class="tool-row-name">${esc(evt.tool_name)}</span>
      <span class="tool-row-value mono">${esc(value)}</span>
    </div>
    <div class="card-detail" id="detail-${evt.eventId}" style="display:none">
      ${buildDetail(evt, evt.hook_event_name)}
    </div>
  `;

  feed.prepend(card);

  if (status === 'running') {
    openToolRows.set(toolRowKey(evt), card);
  }
}

// Flip an open tool row from "running" to "completed" or "failed" and
// stitch in the output (so the detail panel gets the PostToolUse data).
function updateToolRow(card, postEvt, status) {
  card.classList.remove('tool-row-running');
  card.classList.add('tool-row-' + status);
  // Rebuild the expandable detail panel using the PostToolUse payload
  const detail = card.querySelector('.card-detail');
  if (detail) {
    detail.innerHTML = buildDetail(postEvt, postEvt.hook_event_name);
  }
  // Update dataset.eventId so detail-toggle still works via the new event
  card.dataset.eventId = postEvt.eventId;
  card.id = 'evt-' + postEvt.eventId;
  const line = card.querySelector('.tool-row-line');
  if (line) line.setAttribute('onclick', `toggleExpand('${postEvt.eventId}')`);
}

function renderCompactCard(evt) {
  const card = document.createElement('div');
  card.className = 'event-card' + (evt.isBlocking && !evt.decided ? ' blocking' : '') + (evt.decided ? ' decided' : '');
  card.id = 'evt-' + evt.eventId;
  card.dataset.eventId = evt.eventId;
  card.dataset.sessionId = evt.session_id || '';
  if (currentSessionFilter && card.dataset.sessionId !== currentSessionFilter) {
    card.style.display = 'none';
  }

  const time = new Date(evt.receivedAt).toLocaleTimeString();
  const sessionShort = (evt.session_id || '').substring(0, 8);
  const eventName = evt.hook_event_name || 'Unknown';
  const agent = evt._agent || 'unknown';
  const agentLabel = AGENT_NAMES[agent] || agent;
  const sc = statusClass(evt);

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
}

// CodexMonitor-style chat bubble for UserPromptSubmit + Stop events.
// User messages are right-aligned + narrow, assistant messages are left-
// aligned + wide, assistant content is rendered as markdown.
function renderChatBubble(evt, role) {
  const card = document.createElement('div');
  card.className = 'event-card chat-bubble chat-bubble-' + role;
  card.id = 'evt-' + evt.eventId;
  card.dataset.eventId = evt.eventId;
  card.dataset.sessionId = evt.session_id || '';
  if (currentSessionFilter && card.dataset.sessionId !== currentSessionFilter) {
    card.style.display = 'none';
  }

  const time = new Date(evt.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const agent = evt._agent || 'unknown';
  const agentLabel = AGENT_NAMES[agent] || agent;

  let contentHtml;
  if (role === 'user') {
    // User prompts are always plain text
    contentHtml = `<p>${esc(evt.prompt).replace(/\n/g, '<br>')}</p>`;
  } else {
    // Assistant messages get markdown rendering via marked
    const text = evt.last_assistant_message || '';
    if (window.marked) {
      try {
        contentHtml = marked.parse(text, { breaks: true, gfm: true });
      } catch (e) {
        contentHtml = `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
      }
    } else {
      contentHtml = `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
    }
  }

  card.innerHTML = `
    <div class="bubble-row">
      <div class="bubble bubble-${role}">
        <div class="bubble-content markdown">${contentHtml}</div>
        <div class="bubble-meta">
          ${role === 'assistant' ? `<span class="bubble-agent agent-badge agent-${agent}">${esc(agentLabel)}</span>` : ''}
          <span class="bubble-time">${time}</span>
        </div>
        <button class="bubble-copy" title="Copy message" onclick="event.stopPropagation();copyBubble('${evt.eventId}', this)">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M2 9V3a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  `;

  feed.prepend(card);
  enhanceCodeBlocks(card);
}

// Append a copy button to every code block inside this card.
function enhanceCodeBlocks(rootEl) {
  rootEl.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    if (pre.parentElement && pre.parentElement.classList.contains('markdown-codeblock')) return;

    const wrap = document.createElement('div');
    wrap.className = 'markdown-codeblock';

    const header = document.createElement('div');
    header.className = 'markdown-codeblock-header';
    const langClass = [...code.classList].find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';
    header.innerHTML = `
      <span class="markdown-codeblock-lang">${esc(lang || 'code')}</span>
      <button class="markdown-codeblock-copy" onclick="event.stopPropagation();copyCodeBlock(this)">
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
          <path d="M2 9V3a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        copy
      </button>
    `;

    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(header);
    wrap.appendChild(pre);
  });
}

function copyBubble(eventId, btn) {
  const evt = allEvents.find((e) => e.eventId === eventId);
  if (!evt) return;
  const text = evt.prompt || evt.last_assistant_message || '';
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      btn.classList.add('is-copied');
      setTimeout(() => btn.classList.remove('is-copied'), 1500);
    }
  });
}

function copyCodeBlock(btn) {
  const code = btn.closest('.markdown-codeblock')?.querySelector('code');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent || '').then(() => {
    const label = btn.querySelector('svg')?.nextSibling;
    btn.classList.add('is-copied');
    setTimeout(() => btn.classList.remove('is-copied'), 1500);
  });
}

// After each Stop/StopFailure bubble, insert a "—— Done in Xs ——" divider
// marking the turn boundary. The divider is only visible in focused-session
// view; in the global firehose it's hidden via CSS to avoid clutter.
function maybeInsertTurnSeparator(stopEvt) {
  // Walk backwards through the session's events to find the matching UserPromptSubmit
  const sessionEvents = allEvents
    .filter((e) => e.session_id === stopEvt.session_id)
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
  const stopIdx = sessionEvents.findIndex((e) => e.eventId === stopEvt.eventId);
  let userEvt = null;
  for (let i = stopIdx - 1; i >= 0; i--) {
    if (sessionEvents[i].hook_event_name === 'UserPromptSubmit') {
      userEvt = sessionEvents[i];
      break;
    }
  }
  if (!userEvt) return;

  const durationMs = new Date(stopEvt.receivedAt) - new Date(userEvt.receivedAt);
  const label = 'Done in ' + formatElapsed(durationMs);

  const sep = document.createElement('div');
  sep.className = 'turn-complete';
  sep.dataset.sessionId = stopEvt.session_id || '';
  sep.dataset.eventId = 'sep-' + stopEvt.eventId;
  if (currentSessionFilter && sep.dataset.sessionId !== currentSessionFilter) {
    sep.style.display = 'none';
  }
  sep.innerHTML = `
    <span class="turn-complete-line"></span>
    <span class="turn-complete-label">${esc(label)}</span>
    <span class="turn-complete-line"></span>
  `;
  feed.prepend(sep);
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

// =============================================================
// Session sidebar — CodexMonitor-style session list in left column.
// Derives sessions from allEvents (client-side) rather than hitting
// /api/sessions, so the view stays live without extra polling.
// =============================================================

function scheduleSidebarRebuild() {
  if (sidebarRebuildQueued) return;
  sidebarRebuildQueued = true;
  requestAnimationFrame(() => {
    sidebarRebuildQueued = false;
    rebuildSidebar();
  });
}

function buildSessionMap() {
  const bySession = {};
  // Walk events in chronological order so the state machine flips
  // forward (UserPromptSubmit → PreToolUse → PostToolUse → Stop) cleanly.
  const chronological = allEvents.slice().sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
  for (const evt of chronological) {
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
        // State machine fields
        currentTool: null,
        thinkingStartedAt: null,
        runningToolStartedAt: null,
        tokens: null,
      };
    }
    s.eventCount++;
    if (evt._agent && evt._agent !== 'unknown') s._agent = evt._agent;
    if (!s.cwd && evt.cwd) s.cwd = evt.cwd;
    if (!s.cwd && evt.tool_input?.cwd) s.cwd = evt.tool_input.cwd;
    if (!s.model && evt.model) s.model = evt.model;
    if (new Date(evt.receivedAt) >= new Date(s.lastSeen)) {
      s.lastSeen = evt.receivedAt;
      s.lastEventName = evt.hook_event_name;
    }
    if (evt.hook_event_name === 'UserPromptSubmit' && evt.prompt) s.lastContent = evt.prompt;
    if (evt.hook_event_name === 'Stop' && evt.last_assistant_message) s.lastContent = evt.last_assistant_message;
    if (evt.isBlocking && !evt.decided) s.hasBlocking = true;

    // ---- Activity state machine ----
    // Hooks can't tell us "I'm thinking, X tokens so far". But each hook
    // event marks a transition, so we can infer the agent's current mode
    // from event boundaries: between UserPromptSubmit and a tool call we're
    // "thinking", between PreToolUse and PostToolUse we're "running tool",
    // and after Stop / SessionEnd we're "idle".
    const name = evt.hook_event_name;
    if (name === 'UserPromptSubmit') {
      s.thinkingStartedAt = evt.receivedAt;
      s.currentTool = null;
      s.runningToolStartedAt = null;
    } else if (name === 'PreToolUse') {
      s.currentTool = evt.tool_name || 'tool';
      s.runningToolStartedAt = evt.receivedAt;
      s.thinkingStartedAt = null;
    } else if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
      s.currentTool = null;
      s.runningToolStartedAt = null;
      // After a tool returns we usually go back to thinking until the next event
      s.thinkingStartedAt = evt.receivedAt;
    } else if (name === 'Stop' || name === 'SessionEnd' || name === 'StopFailure') {
      s.thinkingStartedAt = null;
      s.runningToolStartedAt = null;
      s.currentTool = null;
    }

    // Best-effort token capture — Claude Code's Stop hook sometimes ships
    // usage stats; if we ever see them, hold onto the latest pair.
    if (evt.usage && (evt.usage.input_tokens != null || evt.usage.output_tokens != null)) {
      s.tokens = { input: evt.usage.input_tokens || 0, output: evt.usage.output_tokens || 0 };
    }
  }

  for (const s of Object.values(bySession)) {
    if (s.hasBlocking) s.status = 'blocked';
    else if (s.currentTool) s.status = 'tool';
    else if (s.thinkingStartedAt) s.status = 'thinking';
    else s.status = 'idle';
  }
  return Object.values(bySession).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
}

// Format milliseconds as `42s` or `1m 14s`, matching Claude Code's UI.
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return total + 's';
  const m = Math.floor(total / 60);
  const r = total % 60;
  return m + 'm ' + r + 's';
}

// 1Hz ticker that updates any element with class="live-elapsed". Each such
// element has data-start-time set to an ISO string; we just diff against now.
function startLiveTicker() {
  setInterval(() => {
    document.querySelectorAll('.live-elapsed').forEach((el) => {
      const start = el.dataset.startTime;
      if (!start) return;
      el.textContent = formatElapsed(Date.now() - new Date(start).getTime());
    });
  }, 1000);
}

function relativeTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 5) return 'now';
  if (diff < 60) return Math.floor(diff) + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

function rebuildSidebar() {
  const sessions = buildSessionMap();
  sessionCountEl.textContent = sessions.length;

  if (sessions.length === 0) {
    sessionListEl.innerHTML = '<div class="sidebar-empty">No sessions yet</div>';
    return;
  }

  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item';
    if (s.session_id === currentSessionFilter) item.classList.add('active');
    item.dataset.sessionId = s.session_id;

    const agentLabel = AGENT_NAMES[s._agent] || s._agent;
    const sid = s.session_id.substring(0, 8);
    const preview = s.lastContent || s.lastEventName || '';

    // Right-side time/elapsed: while working, show live elapsed timer.
    let rightLabel = '';
    if (s.status === 'tool' && s.runningToolStartedAt) {
      rightLabel = `<span class="session-time live-elapsed" data-start-time="${s.runningToolStartedAt}">0s</span>`;
    } else if (s.status === 'thinking' && s.thinkingStartedAt) {
      rightLabel = `<span class="session-time live-elapsed" data-start-time="${s.thinkingStartedAt}">0s</span>`;
    } else {
      rightLabel = `<span class="session-time">${relativeTime(s.lastSeen)}</span>`;
    }

    item.innerHTML = `
      <div class="session-row1">
        <span class="session-status ${s.status}"></span>
        <span class="agent-badge agent-${s._agent}">${esc(agentLabel)}</span>
        <span class="session-id">${esc(sid)}</span>
        ${rightLabel}
      </div>
      <div class="session-preview">${esc(truncate(preview, 60))}</div>
    `;
    item.onclick = () => selectSession(s.session_id);
    sessionListEl.appendChild(item);
  }

  // Re-render the focused session's status bar + composer so they reflect
  // the latest state machine after each new event.
  if (currentSessionFilter) {
    const focused = sessions.find((s) => s.session_id === currentSessionFilter);
    if (focused) {
      renderSessionHeader(focused);
      renderSessionStatusBar(focused);
      renderSessionComposer(focused);
    }
  }
}

function renderSessionHeader(session) {
  sessionHeaderEl.style.display = 'flex';
  const agentEl = document.getElementById('session-header-agent');
  agentEl.textContent = AGENT_NAMES[session._agent] || session._agent;
  agentEl.className = 'session-header-agent agent-badge agent-' + session._agent;
  document.getElementById('session-header-id').textContent = session.session_id.substring(0, 12);
  document.getElementById('session-header-cwd').textContent = session.cwd || '';
}

// CodexMonitor "Working…" pill: spinner + live timer + shimmer label.
// Three modes:
//   - busy  → pill with spinning spinner and shimmer text (thinking / tool)
//   - blocked → pill, amber dot, static label
//   - idle → no pill, just a muted idle summary
function renderSessionStatusBar(session) {
  const bar = document.getElementById('session-status-bar');

  if (session.status === 'blocked') {
    bar.innerHTML = `
      <div class="working working-blocked">
        <span class="session-status blocked"></span>
        <span class="working-text-static">Waiting for approval</span>
      </div>
    `;
    return;
  }

  if (session.status === 'tool' || session.status === 'thinking') {
    const startTime = session.status === 'tool'
      ? session.runningToolStartedAt
      : session.thinkingStartedAt;
    const label = session.status === 'tool'
      ? `Running ${session.currentTool}…`
      : 'Thinking…';
    bar.innerHTML = `
      <div class="working">
        <span class="working-spinner" aria-hidden></span>
        <div class="working-timer">
          <span class="working-timer-clock live-elapsed" data-start-time="${startTime}">0s</span>
        </div>
        <span class="working-text">${esc(label)}</span>
      </div>
    `;
    return;
  }

  // Idle — render a muted summary only (no pill)
  const parts = [`${session.eventCount} events`];
  if (session.tokens) {
    const total = (session.tokens.input || 0) + (session.tokens.output || 0);
    parts.push(`${total} tokens`);
  }
  bar.innerHTML = `
    <div class="working-idle">
      <span class="session-status idle"></span>
      <span class="working-text-static">Idle · ${esc(parts.join(' · '))}</span>
    </div>
  `;
}

// Composer at the bottom of the main view — sends a follow-up message
// to the currently focused session via /api/sessions/:id/message.
function renderSessionComposer(session) {
  const wrap = document.getElementById('session-composer');
  // Only Claude supports resume natively today (see RESUME_SPAWNERS in server.js)
  const supportsResume = session._agent === 'claude';
  const isBusy = session.status !== 'idle';
  const disabled = !supportsResume || isBusy;
  let placeholder;
  if (!supportsResume) {
    placeholder = `Resume not yet supported for ${session._agent}`;
  } else if (isBusy) {
    placeholder = 'Wait for the agent to finish before sending…';
  } else {
    placeholder = 'Send a follow-up message to this session…';
  }

  wrap.innerHTML = `
    <input type="text"
           id="composer-input"
           class="text-input composer-input"
           placeholder="${esc(placeholder)}"
           ${disabled ? 'disabled' : ''}
           onkeydown="if(event.key==='Enter')sendToSession('${esc(session.session_id)}')">
    <button class="btn btn-allow"
            id="composer-send"
            ${disabled ? 'disabled' : ''}
            onclick="sendToSession('${esc(session.session_id)}')">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Send
    </button>
  `;
}

function selectSession(sessionId) {
  currentSessionFilter = sessionId;
  document.querySelectorAll('.session-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.sessionId === sessionId);
  });
  // Filter both event cards AND turn separators by session
  document.querySelectorAll('.event-card, .turn-complete').forEach((el) => {
    el.style.display = el.dataset.sessionId === sessionId ? '' : 'none';
  });
  // Flip feed to natural chat order (newest at bottom) when focused
  feed.classList.add('session-focused');

  const session = buildSessionMap().find((s) => s.session_id === sessionId);
  if (session) {
    renderSessionHeader(session);
    renderSessionStatusBar(session);
    renderSessionComposer(session);
    document.getElementById('session-bottom').style.display = 'flex';
  }
}

function showAllSessions() {
  currentSessionFilter = null;
  document.querySelectorAll('.session-item').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.event-card, .turn-complete').forEach((el) => { el.style.display = ''; });
  feed.classList.remove('session-focused');
  sessionHeaderEl.style.display = 'none';
  document.getElementById('session-bottom').style.display = 'none';
}

async function sendToSession(sessionId) {
  const input = document.getElementById('composer-input');
  const btn = document.getElementById('composer-send');
  if (!input || input.disabled) return;
  const prompt = input.value.trim();
  if (!prompt) return;

  btn.disabled = true;
  input.disabled = true;
  btn.classList.add('btn-loading');

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      // Surface error inline; keep the prompt so user can retry
      const errLabel = document.createElement('div');
      errLabel.className = 'composer-error';
      errLabel.textContent = data.error || 'Failed to send';
      input.parentNode.appendChild(errLabel);
      setTimeout(() => errLabel.remove(), 4000);
      return;
    }
    input.value = '';
    // The next inbound event for this session will trigger rebuildSidebar →
    // renderSessionComposer, which will re-enable the input once status flips
    // to thinking/idle. Until then, the loading state stays.
  } catch (e) {
    console.error('sendToSession failed', e);
  } finally {
    btn.classList.remove('btn-loading');
  }
}

// =============================================================
// New Session modal — spawns an agent via POST /api/sessions/new
// =============================================================

let availableAgents = [];
let selectedAgent = 'claude';

async function loadAgents() {
  try {
    const res = await fetch('/api/agents');
    availableAgents = await res.json();
  } catch {
    availableAgents = ['claude', 'codex', 'opencode', 'openclaw'];
  }
}

function renderAgentPicker() {
  const picker = document.getElementById('agent-picker');
  picker.innerHTML = '';
  for (const agent of availableAgents) {
    const btn = document.createElement('div');
    btn.className = 'agent-option' + (agent === selectedAgent ? ' selected' : '');
    btn.onclick = () => {
      selectedAgent = agent;
      renderAgentPicker();
    };
    const label = AGENT_NAMES[agent] || agent;
    btn.innerHTML = `
      <span class="agent-badge agent-${agent}">${esc(label)}</span>
      <span class="option-check">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
    `;
    picker.appendChild(btn);
  }
}

function openNewSessionModal() {
  document.getElementById('new-session-overlay').style.display = 'flex';
  document.getElementById('new-session-error').textContent = '';
  renderAgentPicker();
  setTimeout(() => document.getElementById('new-prompt').focus(), 50);
}

function closeNewSessionModal() {
  document.getElementById('new-session-overlay').style.display = 'none';
}

async function submitNewSession() {
  const prompt = document.getElementById('new-prompt').value.trim();
  const cwd = document.getElementById('new-cwd').value.trim() || undefined;
  const errEl = document.getElementById('new-session-error');
  errEl.textContent = '';
  if (!prompt) { errEl.textContent = 'Prompt cannot be empty'; return; }

  const btn = document.getElementById('btn-spawn');
  btn.classList.add('btn-loading');
  try {
    const res = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: selectedAgent, prompt, cwd }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      errEl.textContent = data.error || 'Failed to spawn agent';
      btn.classList.remove('btn-loading');
      return;
    }
    closeNewSessionModal();
    document.getElementById('new-prompt').value = '';
  } catch (e) {
    errEl.textContent = String(e.message || e);
  } finally {
    btn.classList.remove('btn-loading');
  }
}

// Refresh relative times every 30s
setInterval(() => { if (allEvents.length > 0) scheduleSidebarRebuild(); }, 30000);

// =============================================================
// Init
// =============================================================
feed.innerHTML = `
  <div class="empty-state">
    <div class="logo">${CIRCLE}</div>
    <h2>Waiting for events…</h2>
    <p>Start a new session, or install hooks on an agent to see events stream in.</p>
  </div>
`;

loadAgents();
startLiveTicker();
connect();

// Auto-focus the most recently active session once the init batch has been
// processed. Matches CodexMonitor's default behavior — landing on a page
// where one session is active → immediately enter chat view for that session.
setTimeout(() => {
  if (!currentSessionFilter) {
    const sessions = buildSessionMap();
    if (sessions.length > 0) selectSession(sessions[0].session_id);
  }
}, 400);
