# Roadmap

## v0.1 — Event Firehose (current)

Single scrolling feed of all events across all sessions. Click to expand. Approve/deny inline. Paseo-aligned interactive UI for Permission/Notification/Elicitation.

## v0.2 — Multi-Session, Chat, CodexMonitor-style UI (in progress)

Goal: align the UX with [CodexMonitor](https://github.com/Dimillian/CodexMonitor).

### Scope

1. **Session sidebar** — left column lists all sessions grouped by agent, with status dot (running/idle/blocked), last message snippet, CWD, relative timestamp. Click to focus a session.
2. **Per-session timeline view** — main area shows only the focused session's events, in chronological order, with composer docked at the bottom.
3. **Composer** — text input to send a message to the focused session. Two paths:
   - **Idle session**: server executes `claude --resume <session_id> -p "<msg>"` on the target machine → new events flow back through hooks.
   - **New session**: user picks agent + CWD, server executes `claude -p "<msg>"` in that dir. New session_id appears in the sidebar.
4. **Session actions** — pin, archive, copy id, jump-to-terminal (via captured `_term_bundle` if present).

### Non-goals

- Interrupting a running turn (requires PTY control, not feasible via hooks).
- Modifying tool arguments before execution (hook return values only allow allow/deny/block).
- Token usage / rate limit tracking (no hook event for this on Claude Code).

### New components

- `apps/server/src/session-actions.js` — new API endpoints:
  - `POST /api/sessions/:id/message` → execute `claude --resume … -p …` remotely
  - `POST /api/sessions/new` → spawn a new session with an initial prompt
  - `GET /api/sessions` → list of distinct session_ids with metadata derived from stored events
- `apps/server/public/*` — sidebar layout, per-session view, composer
- `packages/agent-wrappers/bin/claude-dashboard` — Claude wrapper that can be invoked remotely with a prompt, forwards hook events during execution

## v0.3 — Persistence

- SQLite-backed event store (replace in-memory circular buffer).
- Session history survives server restart.
- Full-text search across events.

## v0.4 — Multi-host

- Dashboard can federate events from multiple remote daemons.
- Each daemon reports its hostname; sidebar groups by host.
- Auth via shared secret + HTTPS.
