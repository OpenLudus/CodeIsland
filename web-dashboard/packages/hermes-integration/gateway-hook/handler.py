"""Dashboard hook — forwards Hermes gateway lifecycle events to the web dashboard.

SCOPE (after Bug #1 fix):
    This handler is ONLY responsible for turn boundaries:
      - SessionStart / SessionEnd     (gateway startup, session end)
      - UserPromptSubmit              (agent:start → the user message came in)
      - Stop                          (agent:end → the agent produced a reply)
      - Notification                  (slash commands)

    Tool-level events (PreToolUse / PostToolUse with full arguments and
    results) are emitted by the CLI plugin at ~/.hermes/plugins/dashboard/,
    which fires from Hermes's plugin system on every tool call (including
    during gateway mode, because model_tools.py calls discover_plugins()
    at import time).

WHY:
    Previously this handler's `agent:step` branch emitted one PostToolUse
    per tool per iteration, but the Hermes `agent:step` context only gives
    us {name, result} per tool — NOT the actual arguments. So those events
    had empty tool_input ({_iteration: N}) and duplicated what the plugin
    was already reporting with full args. Net effect: every tool call
    showed up twice on the dashboard, one row with real data and one
    empty. Cleanest fix is to make this file handle ONLY the events that
    the plugin cannot see (turn boundaries) and let the plugin own the
    per-tool events exclusively.
"""

import json
import os
import urllib.request
import urllib.error

DASHBOARD_URL = os.environ.get("CLAUDE_DASHBOARD_URL", "http://localhost:3456")


def _post(payload):
    """Send payload to dashboard, silently ignoring errors."""
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{DASHBOARD_URL}/api/events",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass  # Never block the agent


def handle(event_type, context):
    """Send turn-boundary event to dashboard. Non-blocking."""
    # Base fields present on every event
    base = {
        "session_id": context.get("session_id", ""),
        "transcript_path": "/.hermes/",
        "_hermes_event": event_type,
        "_platform": context.get("platform", ""),
        "_user_id": context.get("user_id", ""),
    }

    if event_type in ("gateway:startup", "session:start", "session:reset"):
        _post({**base, "hook_event_name": "SessionStart"})

    elif event_type in ("session:end",):
        _post({**base, "hook_event_name": "SessionEnd"})

    elif event_type == "agent:start":
        _post({
            **base,
            "hook_event_name": "UserPromptSubmit",
            "prompt": context.get("message", ""),
        })

    # NOTE: agent:step is intentionally NOT handled here. See module docstring.
    # The CLI plugin fires PreToolUse + PostToolUse with full args for every
    # tool call, including in gateway mode.

    elif event_type == "agent:end":
        _post({
            **base,
            "hook_event_name": "Stop",
            "last_assistant_message": context.get("response", ""),
        })

    elif event_type.startswith("command:"):
        cmd = event_type.split(":", 1)[1]
        _post({
            **base,
            "hook_event_name": "Notification",
            "message": f"/{cmd}",
            "_command": cmd,
        })
