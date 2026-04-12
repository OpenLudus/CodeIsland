# @opencache/agent-wrappers

CLI wrappers for agents that **don't** support native hooks. They spawn the agent as a subprocess, parse its JSON output stream, and synthesize dashboard events.

## Wrappers

### `bin/opencode-dashboard` (Python)

Wraps `opencode run --format json`. Maps OpenCode's streaming NDJSON events to dashboard hook events:

| OpenCode event | Dashboard event |
|---|---|
| (wrapper start) | `SessionStart` |
| message arg | `UserPromptSubmit` |
| `tool_use` (status=completed) | `PreToolUse` + `PostToolUse` |
| `tool_use` (status=error) | `PreToolUse` + `PostToolUseFailure` |
| `text` | (captured as last assistant message) |
| (end) | `Stop` + `SessionEnd` |

Usage:
```bash
opencode-dashboard "Refactor the auth module"
opencode-dashboard --model openrouter/anthropic/claude-sonnet-4-5 "Task"
OPENCODE_MODEL=opencode/gpt-5-nano opencode-dashboard "Task"
```

Environment:
- `CLAUDE_DASHBOARD_URL` — dashboard URL (default `http://localhost:3456`)
- `OPENCODE_MODEL` — default model (default `opencode/gpt-5-nano`)

### `bin/openclaw-dashboard` (Bash)

Wraps `openclaw agent --local`. Post-processes the session JSONL file at `~/.openclaw/agents/main/sessions/<id>.jsonl` and emits events after the run completes.

Usage:
```bash
openclaw-dashboard --message "What are the latest issues?"
```

## Install

Copy the binaries to a location on your `PATH`:

```bash
sudo cp bin/opencode-dashboard /usr/local/bin/
sudo cp bin/openclaw-dashboard /usr/local/bin/
```

## Why not native hooks?

OpenCode and OpenClaw do not expose hook points the way Claude Code / Codex do. The wrapper pattern is a pragmatic workaround — it gives us observability without modifying the agent source code, at the cost of running the agent through our CLI instead of the native one.

For agents that DO expose hooks, prefer [`../hook-scripts/`](../hook-scripts/) instead.
