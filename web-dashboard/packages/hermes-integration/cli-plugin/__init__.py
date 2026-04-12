"""Dashboard plugin — fires for EVERY tool call in both CLI and gateway mode.

model_tools.py calls discover_plugins() at import time, so this plugin is
loaded during gateway startup and invoke_hook("pre_tool_call"/"post_tool_call")
fires with full `args` for every tool, including send_message.

GATEWAY COEXISTENCE (Bug #2 fix):
    In CLI mode, this plugin is the only Hermes→dashboard source, so it
    is responsible for the full lifecycle including Stop on session
    finalize (with empty last_assistant_message, which the dashboard
    tolerates).

    In gateway mode, the gateway-hook/handler.py ALSO runs and fires
    `agent:end` → Stop with the real response text. If the plugin ALSO
    fires Stop on finalize, the dashboard ends up with two Stop events
    per turn, one with the content and one without, which renders the
    empty one as a stray compact card right next to the real bubble.

    To avoid this, we track the session platform at on_session_start and
    skip the finalize Stop for any gateway platform (telegram, discord,
    slack, whatsapp, etc.). CLI is detected by an empty / missing / "cli"
    platform string.

    The platform tracking uses a per-session dict so concurrent gateway
    sessions don't clobber each other's state — Python dict ops are
    GIL-atomic which is sufficient for our use.
"""

import json
import os
import urllib.request

DASHBOARD_URL = os.environ.get("CLAUDE_DASHBOARD_URL", "http://localhost:3456")
_session_id = ""
_session_platforms = {}  # session_id → platform name (for gateway detection)


def _is_gateway_platform(platform):
    """True if the given platform string indicates a gateway session."""
    return bool(platform) and platform not in ("cli", "CLI", "local")


def _send(event_name, **extra):
    try:
        payload = {
            "hook_event_name": event_name,
            "session_id": extra.pop("_sid", _session_id),
            "transcript_path": "/.hermes/",
        }
        payload.update(extra)
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{DASHBOARD_URL}/api/events",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass


def _on_session_start(**kwargs):
    global _session_id
    sid = kwargs.get("session_id", "")
    _session_id = sid
    platform = kwargs.get("platform", "cli") or "cli"
    if sid:
        _session_platforms[sid] = platform
    _send("SessionStart", _platform=platform)


def _on_session_end(**kwargs):
    sid = kwargs.get("session_id", _session_id)
    _session_platforms.pop(sid, None)
    _send("SessionEnd", _sid=sid)


def _on_session_finalize(**kwargs):
    sid = kwargs.get("session_id", _session_id)
    platform = _session_platforms.get(sid, "cli")
    # In gateway mode, the gateway-hook/handler.py's `agent:end` → Stop is
    # authoritative and carries the actual response text. Skipping here
    # prevents a duplicate empty Stop row next to the real assistant bubble.
    if _is_gateway_platform(platform):
        return
    _send("Stop", _sid=sid)


def _pre_tool_call(**kwargs):
    tool_name = kwargs.get("tool_name", "")
    args = kwargs.get("args", kwargs.get("tool_input", kwargs.get("arguments", {})))
    sid = kwargs.get("session_id", _session_id)

    if not isinstance(args, dict):
        try:
            args = json.loads(args) if isinstance(args, str) else {"raw": str(args)}
        except Exception:
            args = {"raw": str(args)}

    payload = dict(
        tool_name=tool_name,
        tool_input=args,
        _sid=sid,
    )

    # send_message → flag it so frontend highlights it as "gateway reply"
    if tool_name == "send_message":
        payload["_gateway_response"] = True

    _send("PreToolUse", **payload)


def _post_tool_call(**kwargs):
    tool_name = kwargs.get("tool_name", "")
    args = kwargs.get("args", kwargs.get("tool_input", kwargs.get("arguments", {})))
    result = kwargs.get("result", kwargs.get("tool_result", ""))
    sid = kwargs.get("session_id", _session_id)

    if not isinstance(args, dict):
        try:
            args = json.loads(args) if isinstance(args, str) else {"raw": str(args)}
        except Exception:
            args = {"raw": str(args)}

    result_str = str(result)
    if len(result_str) > 2000:
        result_str = result_str[:2000] + "\n…(truncated)"

    payload = dict(
        tool_name=tool_name,
        tool_input=args,
        tool_response=result_str,
        _sid=sid,
    )

    if tool_name == "send_message":
        payload["_gateway_response"] = True
        # Lift the message content into a top-level field so the summary shows it
        payload["_gateway_message"] = args.get("message", args.get("content", ""))
        payload["_gateway_target"] = args.get("target", args.get("chat_id", ""))
        payload["_gateway_platform"] = args.get("platform", "")

    _send("PostToolUse", **payload)


def register(ctx):
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
