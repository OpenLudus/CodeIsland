"""Dashboard hook — forwards Hermes events to the web dashboard via HTTP."""

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
    """Send event to dashboard. Non-blocking, errors are silently ignored."""
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

    elif event_type == "agent:step":
        # Emit one PostToolUse per tool called in this iteration so every
        # send_message / web_search / execute_code call gets its own card.
        tools = context.get("tools", [])
        iteration = context.get("iteration", 0)

        if tools:
            for tool in tools:
                if not isinstance(tool, dict):
                    tool = {"name": str(tool), "result": None}
                tool_name = tool.get("name", "")
                result = tool.get("result", "")
                # Truncate large results so the dashboard stays readable
                if isinstance(result, str) and len(result) > 2000:
                    result = result[:2000] + "\n…(truncated)"

                # send_message → special label so the UI highlights it as
                # "response sent to gateway user"
                hook_name = "PostToolUse"
                payload = {
                    **base,
                    "hook_event_name": hook_name,
                    "tool_name": tool_name,
                    "tool_input": {"_iteration": iteration},
                    "tool_response": result,
                    "_iteration": iteration,
                }
                if tool_name == "send_message":
                    # Flag it so the frontend can highlight it distinctively
                    payload["_gateway_response"] = True
                _post(payload)
        else:
            # Fallback: no tool detail, emit bare step event
            tool_names = context.get("tool_names", [])
            _post({
                **base,
                "hook_event_name": "PostToolUse",
                "tool_name": ", ".join(tool_names) if tool_names else "(thinking)",
                "_iteration": iteration,
            })

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


def _map_event(event_type):
    """Map Hermes events to Claude-style event names for the dashboard."""
    mapping = {
        "gateway:startup": "SessionStart",
        "session:start": "SessionStart",
        "session:end": "SessionEnd",
        "session:reset": "SessionEnd",
        "agent:start": "UserPromptSubmit",
        "agent:step": "PostToolUse",
        "agent:end": "Stop",
    }
    if event_type.startswith("command:"):
        return "Notification"
    return mapping.get(event_type, event_type)
