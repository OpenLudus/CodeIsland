#!/bin/bash
# Install Claude Hook Dashboard hooks into all detected agent settings files
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SRC="${SCRIPT_DIR}/dashboard-hook.sh"

echo "=== Claude Hook Dashboard Installer ==="

# ── Helper: write hooks into a Claude-format settings.json ──────────────────
install_claude_format() {
  local SETTINGS="$1"
  local HOOK_DEST="$2"
  local LABEL="$3"

  local HOOK_DIR
  HOOK_DIR="$(dirname "$HOOK_DEST")"
  mkdir -p "$HOOK_DIR"
  cp "$HOOK_SRC" "$HOOK_DEST"
  chmod +x "$HOOK_DEST"
  echo "[OK] Hook script → $HOOK_DEST"

  if [ -f "$SETTINGS" ]; then
    cp "$SETTINGS" "${SETTINGS}.bak"
    echo "[OK] Backed up $SETTINGS"
  fi

  node -e "
const fs = require('fs');
const path = '${SETTINGS}';
const hookCommand = '${HOOK_DEST}';

let settings = {};
if (fs.existsSync(path)) {
  try {
    let raw = fs.readFileSync(path, 'utf8');
    raw = raw.replace(/\\/\\/.*/gm, '').replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');
    settings = JSON.parse(raw);
  } catch(e) {
    console.error('Warning: could not parse ' + path + ', starting fresh');
    settings = {};
  }
}

const events = [
  ['SessionStart', 5], ['SessionEnd', 5], ['Setup', 5],
  ['UserPromptSubmit', 5],
  ['PreToolUse', 5], ['PostToolUse', 5], ['PostToolUseFailure', 5],
  ['PermissionRequest', 86400], ['PermissionDenied', 5],
  ['Stop', 5], ['StopFailure', 5],
  ['SubagentStart', 5], ['SubagentStop', 5],
  ['PreCompact', 5], ['PostCompact', 5],
  ['Notification', 86400], ['Elicitation', 86400], ['ElicitationResult', 5],
  ['TaskCreated', 5], ['TaskCompleted', 5],
  ['TeammateIdle', 5],
  ['FileChanged', 5], ['CwdChanged', 5], ['ConfigChange', 5],
  ['InstructionsLoaded', 5],
  ['WorktreeCreate', 5], ['WorktreeRemove', 5],
];

if (!settings.hooks) settings.hooks = {};
for (const [event, timeout] of events) {
  let entries = settings.hooks[event] || [];
  entries = entries.filter(e => {
    const hooks = e.hooks || [];
    return !hooks.some(h => (h.command || '').includes('dashboard-hook'));
  });
  entries.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand, timeout }] });
  settings.hooks[event] = entries;
}

fs.writeFileSync(path, JSON.stringify(settings, null, 2));
console.log('[OK] Hooks written → ${LABEL}');
"
}

# ── Helper: write hooks into a Codex-format hooks.json ──────────────────────
install_codex_format() {
  local HOOKS_FILE="$1"
  local HOOK_DEST="$2"
  local LABEL="$3"

  local HOOK_DIR
  HOOK_DIR="$(dirname "$HOOK_DEST")"
  mkdir -p "$HOOK_DIR"
  cp "$HOOK_SRC" "$HOOK_DEST"
  chmod +x "$HOOK_DEST"
  echo "[OK] Hook script → $HOOK_DEST"

  if [ -f "$HOOKS_FILE" ]; then
    cp "$HOOKS_FILE" "${HOOKS_FILE}.bak"
    echo "[OK] Backed up $HOOKS_FILE"
  fi

  node -e "
const fs = require('fs');
const path = '${HOOKS_FILE}';
const hookCommand = '${HOOK_DEST}';

let config = {};
if (fs.existsSync(path)) {
  try { config = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
}
if (!config.hooks) config.hooks = {};

const events = [
  'pre_tool_call', 'post_tool_call', 'session_start', 'session_end',
  'exec_command', 'file_edit',
];
for (const event of events) {
  let entries = config.hooks[event] || [];
  entries = entries.filter(e => !(e.command || '').includes('dashboard-hook'));
  entries.push({ command: hookCommand });
  config.hooks[event] = entries;
}
fs.writeFileSync(path, JSON.stringify(config, null, 2));
console.log('[OK] Hooks written → ${LABEL}');
"
}

# ── 1. Claude Code ───────────────────────────────────────────────────────────
if [ -d "$HOME/.claude" ]; then
  install_claude_format \
    "$HOME/.claude/settings.json" \
    "$HOME/.claude/hooks/dashboard-hook.sh" \
    "Claude Code"
else
  echo "[--] Claude Code not found (~/.claude), skipping"
fi

# ── 2. Codex ─────────────────────────────────────────────────────────────────
if [ -d "$HOME/.codex" ]; then
  install_codex_format \
    "$HOME/.codex/hooks.json" \
    "$HOME/.codex/hooks/dashboard-hook.sh" \
    "Codex"
else
  echo "[--] Codex not found (~/.codex), skipping"
fi

# ── 3. Factory / Droid ───────────────────────────────────────────────────────
if [ -d "$HOME/.factory" ]; then
  install_claude_format \
    "$HOME/.factory/settings.json" \
    "$HOME/.factory/hooks/dashboard-hook.sh" \
    "Factory"
else
  echo "[--] Factory not found (~/.factory), skipping"
fi

# ── 4. Gemini CLI ────────────────────────────────────────────────────────────
if [ -d "$HOME/.gemini" ]; then
  install_claude_format \
    "$HOME/.gemini/settings.json" \
    "$HOME/.gemini/hooks/dashboard-hook.sh" \
    "Gemini CLI"
else
  echo "[--] Gemini CLI not found (~/.gemini), skipping"
fi

# ── 5. OpenCode ──────────────────────────────────────────────────────────────
OPENCODE_DIR="$HOME/.local/share/opencode"
if command -v opencode >/dev/null 2>&1 || [ -d "$OPENCODE_DIR" ]; then
  install_claude_format \
    "$OPENCODE_DIR/settings.json" \
    "$OPENCODE_DIR/hooks/dashboard-hook.sh" \
    "OpenCode"
else
  echo "[--] OpenCode not found (~/.local/share/opencode), skipping"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== Installation complete ==="
echo ""
echo "Usage:"
echo "  1. Start the dashboard:  cd ${SCRIPT_DIR} && node server.js"
echo "  2. Open browser:         http://localhost:3456"
echo "  3. Start any agent (Claude, Codex, Factory, Gemini, OpenCode)"
echo ""
echo "For remote VM, set the dashboard URL in your shell profile:"
echo "  export CLAUDE_DASHBOARD_URL=http://<server-ip>:3456"
