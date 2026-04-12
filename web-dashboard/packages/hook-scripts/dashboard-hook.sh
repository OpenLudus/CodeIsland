#!/bin/bash
# Claude Hook Dashboard — hook script
# Reads JSON from stdin, forwards to dashboard server.
# Blocking events (PermissionRequest, Notification+question) poll for decision.

DASHBOARD_URL="${CLAUDE_DASHBOARD_URL:-http://localhost:3456}"
POLL_INTERVAL=0.5
MAX_WAIT=86400

# Read entire stdin
INPUT=$(cat)

# Quick exit if empty
[ -z "$INPUT" ] && exit 0

# Use python3 for robust JSON parsing (handles nested JSON, embedded quotes, newlines)
read -r EVENT_NAME HAS_QUESTION <<< "$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    name = d.get('hook_event_name', '')
    has_q = 'yes' if 'question' in d else 'no'
    print(name, has_q)
except Exception:
    print('', 'no')
")"

# Determine if blocking
IS_BLOCKING="no"
if [ "$EVENT_NAME" = "PermissionRequest" ]; then
  IS_BLOCKING="yes"
elif [ "$EVENT_NAME" = "Notification" ] && [ "$HAS_QUESTION" = "yes" ]; then
  IS_BLOCKING="yes"
elif [ "$EVENT_NAME" = "Elicitation" ]; then
  IS_BLOCKING="yes"
fi

# POST event to server
RESPONSE=$(curl -s -X POST "${DASHBOARD_URL}/api/events" \
  -H "Content-Type: application/json" \
  -d "$INPUT" \
  --connect-timeout 3 \
  --max-time 5 2>/dev/null)

# Non-blocking: done
if [ "$IS_BLOCKING" = "no" ]; then
  exit 0
fi

# Extract eventId via python3
EVENT_ID=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('eventId', ''))
except Exception:
    print('')
")

if [ -z "$EVENT_ID" ]; then
  # Server unreachable or bad response — exit silently
  exit 0
fi

# Poll for decision
ELAPSED=0
while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  DECISION=$(curl -s "${DASHBOARD_URL}/api/decisions/${EVENT_ID}" \
    --connect-timeout 3 \
    --max-time 5 2>/dev/null)

  # Check if decision is non-empty (not just "{}")
  if [ -n "$DECISION" ] && [ "$DECISION" != "{}" ]; then
    echo "$DECISION"
    exit 0
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + 1))
done

# Timeout — return empty
echo "{}"
exit 0
