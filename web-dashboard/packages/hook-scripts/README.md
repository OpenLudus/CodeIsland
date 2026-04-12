# @openludus/hook-scripts

Native hook integration for agents that already support hook systems (Claude Code, Codex, Factory, Gemini, OpenCode).

## Files

| File | Purpose |
|---|---|
| `dashboard-hook.sh` | The hook script itself. Reads a JSON event from stdin, POSTs it to the dashboard, and polls for a decision if the event is blocking (PermissionRequest / Notification / Elicitation). |
| `install.sh` | Auto-installer. Detects installed agents and writes hook config into each agent's `settings.json` (Claude-format) or `hooks.json` (Codex-format). |

## How blocking works

When the hook script receives an event with `hook_event_name == "PermissionRequest"` (or `Notification` with `question`, or `Elicitation`), it:

1. POSTs the event to `/api/events`, gets back an `eventId`.
2. Polls `/api/decisions/{eventId}` every 500ms, waiting up to `MAX_WAIT=86400` seconds.
3. When a decision arrives from the browser UI, writes the JSON decision to stdout.
4. The host agent (Claude Code / Codex / etc.) reads that JSON from the hook's stdout and honors it.

## Environment

- `CLAUDE_DASHBOARD_URL` — Server URL (default `http://localhost:3456`). Set this when the dashboard runs on a different machine.

## Install

```bash
bash install.sh
# or from the monorepo root:
npm run install-hooks
```

## Supported agents

- **Claude Code** (`~/.claude/settings.json`) — 26 hook event types
- **Codex** (`~/.codex/hooks.json`) — 6 hook event types
- **Factory / Droid** (`~/.factory/settings.json`) — Claude format
- **Gemini CLI** (`~/.gemini/settings.json`) — Claude format
- **OpenCode** (`~/.local/share/opencode/settings.json`) — Claude format
