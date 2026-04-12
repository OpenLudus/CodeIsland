# OpenCache Web Dashboard

A web-based transparency layer for local AI coding agents: observe every tool call, approve permission requests remotely, and interact with blocking decisions from any browser.

Currently supports: **Claude Code**, **Codex**, **Factory/Droid**, **Gemini CLI**, **OpenCode**, **OpenClaw**, **Hermes**.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Browser / Phone                       │
│              (http://<server-ip>:3456)                    │
└───────────────────────────┬──────────────────────────────┘
                            │ SSE (real-time events)
                            │ POST /api/decisions (approvals)
┌───────────────────────────▼──────────────────────────────┐
│           Dashboard Server (apps/server)                  │
│   Zero-dep Node.js: HTTP + SSE, in-memory event store    │
└───────────────────────────┬──────────────────────────────┘
                            │ POST /api/events
              ┌─────────────┼─────────────┐
              │             │             │
┌─────────────▼───┐ ┌───────▼───────┐ ┌──▼────────────────┐
│ hook-scripts    │ │ agent-wrappers │ │ hermes-integration │
│ (native hooks)  │ │ (no-hook CLIs) │ │ (Hermes plugin)    │
│                 │ │                │ │                    │
│ Claude Code     │ │ OpenCode       │ │ Gateway handler    │
│ Codex, Factory  │ │ OpenClaw       │ │ CLI plugin         │
│ Gemini          │ │                │ │                    │
└─────────────────┘ └────────────────┘ └────────────────────┘
```

## Monorepo Layout

| Path | Purpose |
|---|---|
| `apps/server/` | Node.js server — ingests events, serves the UI, broadcasts over SSE |
| `packages/hook-scripts/` | Shell scripts installed into each agent's settings.json — forwards hook events to the server |
| `packages/agent-wrappers/` | CLI wrappers for agents without native hook support (OpenCode, OpenClaw) |
| `packages/hermes-integration/` | Hermes-specific handlers for both gateway mode and CLI plugin mode |
| `docs/` | Architecture notes, setup guides |

## Quick Start

### 1. Run the dashboard server

```bash
cd apps/server && npm start
# or from repo root: npm start
```

Opens at http://localhost:3456

### 2. Install hooks into your agents

```bash
npm run install-hooks
```

This detects installed agents under `~/.claude`, `~/.codex`, `~/.factory`, `~/.gemini`, `~/.local/share/opencode` and writes the hook config into each.

### 3. (Optional) Install wrappers for OpenCode / OpenClaw

```bash
sudo cp packages/agent-wrappers/bin/opencode-dashboard /usr/local/bin/
sudo cp packages/agent-wrappers/bin/openclaw-dashboard /usr/local/bin/
```

Then run agents via the wrappers instead of the native CLI:
```bash
opencode-dashboard "Refactor the auth module"
openclaw-dashboard --message "What are the latest issues?"
```

### 4. (Optional) Install Hermes integration

```bash
# Gateway hook
mkdir -p ~/.hermes/hooks/dashboard
cp packages/hermes-integration/gateway-hook/handler.py ~/.hermes/hooks/dashboard/

# CLI plugin (auto-loads from ~/.hermes/plugins/)
mkdir -p ~/.hermes/plugins/dashboard
cp packages/hermes-integration/cli-plugin/__init__.py ~/.hermes/plugins/dashboard/
```

## Remote Dashboard

If the server runs on a different machine (e.g. a VPS or Tailscale host):

```bash
export CLAUDE_DASHBOARD_URL=http://<server-ip>:3456
```

Add this to your shell profile on the machine where agents run.

## Current Capabilities

- ✅ Real-time event stream from 7+ agent types
- ✅ Allow/Deny for `PermissionRequest` hooks
- ✅ Option selection for `Notification` (Plan Mode, etc.)
- ✅ Text input for `Elicitation` / open-ended questions
- ✅ Session grouping via `session_id`
- ✅ Per-session timeline view (all events in chronological order)
- ✅ Gateway message transparency (Hermes `send_message` tool capture)
- ⚠️ **Limitation**: Hook-based design means we observe but cannot inject messages into running agents. See [docs/ROADMAP.md](docs/ROADMAP.md) for v2 plans.

## License

MIT
