# Architecture

## Design Principle: Hook-based Observability

We are a **second-layer harness** — a remote observer that sits on top of each agent's own hook system. We do not spawn or wrap agents (except for OpenCode/OpenClaw which lack hooks). We do not proxy API calls. We do not read or modify agent state.

```
┌────────────────────┐          hook JSON stdin
│  Claude Code       │ ────────────────────────┐
│  (running normally)│                         ▼
└────────────────────┘              ┌──────────────────────┐
                                    │  dashboard-hook.sh    │
                                    │  POSTs to server      │
                                    │  polls for decision   │
                                    └──────────┬───────────┘
                                               │ HTTP
┌──────────────────────────┐                   ▼
│     Browser UI           │ ◄───── SSE ── ┌─────────────┐
│  approvals, selections   │ ───── POST ─► │   Server    │
└──────────────────────────┘               └─────────────┘
```

This means:

| Property | Value |
|---|---|
| Reversibility | Can uninstall in 30 seconds (`rm` the hook entries from settings.json) |
| Invasiveness | Zero — agent runs exactly as normal; we just get copies of hook JSON |
| Detectability | None — to Anthropic/OpenAI we look identical to any user-written hook |
| Limitation | **One-way**. Cannot inject messages into a running agent. Cannot modify tool arguments. |

See [Paseo](https://github.com/getpaseo/paseo) and [CodexMonitor](https://github.com/Dimillian/CodexMonitor) for contrasting approaches that spawn agents as subprocesses.

## Event Flow

1. **Agent runs a tool**: Claude Code decides to call `Bash("ls")`.
2. **Hook fires**: Claude spawns `dashboard-hook.sh` and pipes a JSON payload to its stdin:
   ```json
   {
     "hook_event_name": "PreToolUse",
     "session_id": "abc123",
     "tool_name": "Bash",
     "tool_input": {"command": "ls"}
   }
   ```
3. **Hook script POSTs to server**: `curl -X POST http://localhost:3456/api/events` with the JSON body.
4. **Server broadcasts**: Server assigns an `eventId`, stores the record, and fans it out to all SSE clients.
5. **Browser renders**: The UI receives the SSE event, renders a card in the feed.
6. **(blocking only) Hook polls**: For `PermissionRequest` / `Notification+question` / `Elicitation`, the hook script polls `/api/decisions/{eventId}` every 500ms.
7. **(blocking only) User decides**: Browser UI shows approve/deny/option buttons. User clicks. UI POSTs decision to `/api/decisions/{eventId}`.
8. **Hook script returns**: Hook script writes the decision JSON to stdout. Claude Code reads it and acts accordingly.

## Data Model

### Event record (server-side)

```typescript
type EventRecord = {
  eventId: string;          // UUID assigned by server
  receivedAt: string;       // ISO 8601
  isBlocking: boolean;      // true for PermissionRequest / Notification+question / Elicitation
  decided: boolean;
  decision: DecisionPayload | null;
  _agent: 'claude' | 'codex' | 'factory' | 'gemini' | 'opencode' | 'openclaw' | 'hermes' | 'unknown';

  // … raw hook JSON fields spread at top level:
  hook_event_name: string;
  session_id: string;
  tool_name?: string;
  tool_input?: object;
  tool_response?: object | string;
  // etc.
};
```

### Agent source detection

The server infers `_agent` from the hook payload in priority order:

1. Explicit `_source` field in the payload (added by wrappers)
2. `transcript_path` prefix matching — e.g. `~/.cursor/projects/…` → `cursor`
3. Default: `unknown`

See `apps/server/src/server.js:inferSource()`.

## Agent Support Matrix

| Agent | Integration | Notes |
|---|---|---|
| Claude Code | `packages/hook-scripts/` | Native hooks, 26 event types, full blocking support |
| Codex | `packages/hook-scripts/` | Native hooks, 6 event types |
| Factory / Droid | `packages/hook-scripts/` | Claude-format hooks |
| Gemini CLI | `packages/hook-scripts/` | Claude-format hooks |
| OpenCode (via hooks) | `packages/hook-scripts/` | Claude-format hooks |
| OpenCode (via wrapper) | `packages/agent-wrappers/bin/opencode-dashboard` | `opencode run --format json` parser |
| OpenClaw | `packages/agent-wrappers/bin/openclaw-dashboard` | JSONL session file post-processor |
| Hermes | `packages/hermes-integration/` | Gateway hook + CLI plugin |
