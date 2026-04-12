# @opencache/hermes-integration

Transparency for Hermes — an AI gateway that orchestrates multiple models and protocols (Telegram, Discord, Slack, ...).

Hermes has **two** hook systems:

1. **Gateway hooks** (`~/.hermes/hooks/`) — triggered per iteration via `HOOK.yaml` + handler function
2. **CLI plugins** (`~/.hermes/plugins/`) — triggered per individual tool call via `invoke_hook("pre_tool_call" / "post_tool_call")`

**Key discovery**: CLI plugins fire during **gateway mode** because `model_tools.py` calls `discover_plugins()` at module import time. This means we can capture full `send_message` tool arguments (including the message content sent to Telegram/Discord) *without* modifying Hermes source code.

## Files

### `gateway-hook/handler.py`

Handler registered in `~/.hermes/hooks/dashboard/HOOK.yaml`. Fires on `agent:step` for each iteration of a gateway session. Emits events per tool in the iteration; flags `send_message` calls with `_gateway_response: True`.

Limitation: `agent:step.tools` only contains `{name, result}` — not the tool arguments. For the full payload of `send_message`, use the CLI plugin below.

### `cli-plugin/__init__.py`

Python package installed under `~/.hermes/plugins/dashboard/`. Fires on every `pre_tool_call` / `post_tool_call` event, with full `args` including `send_message` content (platform, recipient, message).

Dashboard events emitted:
- `PreToolUse` with `tool_input` populated
- `PostToolUse` with `tool_response`
- For `send_message`: adds `_gateway_response: True`, `_gateway_message`, `_gateway_target`, `_gateway_platform` so the UI can highlight them as "gateway replies"

## Install

```bash
# Gateway hook
mkdir -p ~/.hermes/hooks/dashboard
cp gateway-hook/handler.py ~/.hermes/hooks/dashboard/
# (requires HOOK.yaml registration — see Hermes docs)

# CLI plugin
mkdir -p ~/.hermes/plugins/dashboard
cp cli-plugin/__init__.py ~/.hermes/plugins/dashboard/
# Auto-loaded by Hermes at startup
```

Both files read `CLAUDE_DASHBOARD_URL` from env for the dashboard endpoint.
