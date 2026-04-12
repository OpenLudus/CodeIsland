// tool-taxonomy.js
//
// Single source of truth for cross-agent tool rendering.
// Final count: 12 semantic categories + 'unknown' fallback.
//
// Research basis (all read from official sources):
//   - Claude Code:  cc-recovered-main/src/tools/* (40+ builtin tools)
//   - Codex:        codex-rs/tools/src/*          (apply_patch merged into edit)
//   - OpenCode:     opencode-official/packages/opencode/src/tool/*.ts
//   - Hermes:       hermes-official/tools/*       (cross-platform gateway)
//
// The 12 categories: shell, read, write, edit, search, fetch, todo, plan,
// subagent, question, message, mcp. apply_patch is NOT its own category —
// it's a transport form, not a distinct user semantic; Codex apply_patch,
// OpenCode apply_patch, and Hermes patch all classify as 'edit'.
//
// Responsibilities:
//   1. classifyTool(toolName, agent)  — map any agent's tool name to 1 of 12
//      canonical semantic categories (+ 'unknown' fallback).
//   2. normalizeToolInput(category, toolName, input)  — extract a clean
//      display value from whatever the agent's tool_input shape happens to be.
//   3. CATEGORY_LABELS                — canonical label shown in the UI row,
//      independent of the raw tool_name (so Claude's Bash, Codex's exec_command,
//      OpenCode's bash, and Hermes's terminal all show as "Shell").
//
// Everything is exposed on the global `ToolTaxonomy` object; no module system.

(function () {
  'use strict';

  // ─── Category labels (shown as the canonical tool name in the row) ─────
  const CATEGORY_LABELS = {
    shell:     'Shell',
    read:      'Read',
    write:     'Write',
    edit:      'Edit',
    search:    'Search',
    fetch:     'Fetch',
    todo:      'Todo',
    plan:      'Plan',
    subagent:  'Agent',
    question:  'Question',
    message:   'Message',
    mcp:       'MCP',
    unknown:   null,   // caller should fall back to raw tool_name
  };

  // ─── Static tool-name → category map ───────────────────────────────────
  // Keys are CASE-SENSITIVE — every agent's actual raw name is listed.
  // Ambiguous names (e.g. "send_message") are resolved by classifyTool().
  const TOOL_CATEGORY = {
    // Shell execution
    // Claude:
    'Bash': 'shell', 'PowerShell': 'shell',
    // Codex:
    'exec_command': 'shell', 'shell': 'shell', 'shell_command': 'shell',
    'exec': 'shell', 'command': 'shell', 'local_shell': 'shell',
    'write_stdin': 'shell',
    // OpenCode:
    'bash': 'shell',
    // Hermes:
    'terminal': 'shell', 'execute_code': 'shell',

    // File read / directory listing
    // Claude:
    'Read': 'read',
    // Codex:
    'list_dir': 'read',
    // OpenCode:
    'read': 'read', 'ls': 'read',
    // Hermes:
    'read_file': 'read',

    // File write (create)
    // Claude:
    'Write': 'write',
    // OpenCode + Hermes:
    'write': 'write', 'write_file': 'write', 'create_file': 'write',

    // File edit / patch (modify existing — Patch merged into Edit per user request)
    // Claude:
    'Edit': 'edit', 'MultiEdit': 'edit', 'NotebookEdit': 'edit',
    // Codex:
    'apply_patch': 'edit',
    // OpenCode:
    'edit': 'edit', 'multiedit': 'edit',
    // Hermes:
    'patch': 'edit',
    // Catch-alls:
    'apply_diff': 'edit', 'str_replace_editor': 'edit',

    // Search (file-name / content / code)
    // Claude:
    'Grep': 'search', 'Glob': 'search', 'ToolSearch': 'search',
    // Codex:
    'tool_search': 'search', 'tool_suggest': 'search',
    // OpenCode:
    'grep': 'search', 'glob': 'search', 'codesearch': 'search',
    // Hermes:
    'search_files': 'search', 'session_search': 'search',
    // Catch-all:
    'search': 'search',

    // Web fetch / search / image view
    // Claude:
    'WebFetch': 'fetch', 'WebSearch': 'fetch',
    // Codex:
    'web_search': 'fetch', 'view_image': 'fetch',
    // OpenCode:
    'webfetch': 'fetch', 'websearch': 'fetch',
    // Hermes:
    'web_extract': 'fetch',
    // Catch-all:
    'web_fetch': 'fetch',

    // Todo / task checklist
    // Claude:
    'TodoWrite': 'todo', 'TodoRead': 'todo',
    // OpenCode:
    'todowrite': 'todo',
    // Hermes:
    'todo': 'todo',

    // Plan mode / update plan
    // Claude:
    'EnterPlanMode': 'plan', 'ExitPlanMode': 'plan',
    // Codex:
    'update_plan': 'plan',
    // OpenCode:
    'plan': 'plan', 'plan_exit': 'plan',

    // Sub-agent spawning (NOTE: "send_message" intentionally omitted — see classifyTool)
    // Claude:
    'Agent': 'subagent', 'Task': 'subagent',
    'TeamCreate': 'subagent', 'TeamDelete': 'subagent',
    // Codex:
    'spawn_agent': 'subagent', 'send_input': 'subagent',
    'followup_task': 'subagent', 'wait_agent': 'subagent',
    'close_agent': 'subagent', 'resume_agent': 'subagent',
    'list_agents': 'subagent', 'spawn_agents_on_csv': 'subagent',
    'report_agent_job_result': 'subagent',
    // OpenCode:
    'task': 'subagent',
    // Hermes:
    'delegate_task': 'subagent',

    // User question / clarification / permission request
    // Claude:
    'AskUserQuestion': 'question',
    // Codex:
    'request_user_input': 'question', 'request_permissions': 'question',
    // OpenCode:
    'question': 'question',
    // Hermes:
    'clarify': 'question',

    // Message (cross-platform gateway, teammate messaging)
    // Claude:
    'SendMessage': 'message', 'SendUserMessage': 'message',
    // "send_message" → resolved dynamically in classifyTool()
    //   Codex: subagent-to-subagent (CollabAgentToolCall)
    //   Hermes: cross-platform gateway send

    // MCP (static + dynamic external tools)
    // Claude:
    'MCPTool': 'mcp',
    'ListMcpResourcesTool': 'mcp', 'ReadMcpResourceTool': 'mcp',
    // Codex:
    'list_mcp_resources': 'mcp', 'list_mcp_resource_templates': 'mcp',
    'read_mcp_resource': 'mcp',
    // Hermes:
    'mcp_tool': 'mcp',
  };

  // ─── Classification function ───────────────────────────────────────────
  // Ambiguous-name handling lives here so the static map can stay flat.
  function classifyTool(toolName, agent) {
    if (!toolName) return 'unknown';

    // send_message is overloaded:
    //   hermes  → cross-platform gateway (message)
    //   codex   → agent-to-agent in CollabAgentToolCall (subagent)
    //   (claude uses SendMessage/SendUserMessage, not send_message)
    if (toolName === 'send_message') {
      return agent === 'hermes' ? 'message' : 'subagent';
    }

    // Dynamic MCP tools may come in as "mcp__something__tool_name".
    if (toolName.startsWith('mcp__')) return 'mcp';

    return TOOL_CATEGORY[toolName] || 'unknown';
  }

  // ─── Helpers ───────────────────────────────────────────────────────────
  function basename(p) {
    if (!p || typeof p !== 'string') return '';
    const idx = p.lastIndexOf('/');
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function firstString(obj, keys) {
    for (const k of keys) {
      const v = obj && obj[k];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  }

  // Parse a patch text (Codex "*** Add/Update/Delete File:" or unified diff)
  // into a list of { kind, path } entries.
  function parsePatchFiles(patchText) {
    if (typeof patchText !== 'string') return [];
    const out = [];
    for (const line of patchText.split('\n')) {
      // Codex freeform header
      const codex = line.match(/^\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+)$/);
      if (codex) {
        out.push({ kind: codex[1], path: codex[2].trim() });
        continue;
      }
      // Unified diff target line
      const unified = line.match(/^\+\+\+\s+b\/(.+)$/);
      if (unified) {
        out.push({ kind: 'Update', path: unified[1].trim() });
      }
    }
    return out;
  }

  // ─── Normalization per category ────────────────────────────────────────
  // Returns { displayValue: string, mono: boolean, extras?: any }
  //   displayValue  — the text shown in the tool row's right column
  //   mono          — true means render in monospace (for paths, commands, diffs)
  function normalizeToolInput(category, toolName, input) {
    input = input || {};

    switch (category) {
      case 'shell': {
        const cmdRaw = input.command || input.cmd || input.script || input.code;
        const cmd = Array.isArray(cmdRaw) ? cmdRaw.join(' ') : cmdRaw;
        const desc = input.description;
        return { displayValue: desc || cmd || '', mono: !desc && !!cmd };
      }

      case 'read': {
        const fp = input.file_path || input.filePath || input.path || input.dir_path;
        const tail = [];
        if (input.offset != null) tail.push('@' + input.offset);
        if (input.limit != null) tail.push('+' + input.limit);
        return {
          displayValue: fp ? (fp + (tail.length ? ' ' + tail.join(' ') : '')) : '',
          mono: true,
        };
      }

      case 'write': {
        const fp = input.file_path || input.filePath || input.path;
        return { displayValue: fp || '', mono: true };
      }

      case 'edit': {
        // MultiEdit: edits[] array
        if (Array.isArray(input.edits) && input.edits.length) {
          const fp = input.file_path || input.filePath || input.path;
          return {
            displayValue: fp
              ? `${fp} (${input.edits.length} edits)`
              : `${input.edits.length} edits`,
            mono: true,
          };
        }
        // Codex apply_patch: input.input is a freeform lark-grammar patch text
        if (toolName === 'apply_patch' && typeof input.input === 'string') {
          const files = parsePatchFiles(input.input);
          if (files.length === 1) {
            return { displayValue: `${files[0].kind} ${files[0].path}`, mono: true };
          }
          if (files.length > 1) {
            return { displayValue: `${files.length} files`, mono: true };
          }
        }
        // OpenCode apply_patch (unified diff in input.patch) OR Hermes patch
        const patchText = input.patch || input.diff || input.unified_diff;
        if (typeof patchText === 'string') {
          const files = parsePatchFiles(patchText);
          if (files.length === 1) return { displayValue: files[0].path, mono: true };
          if (files.length > 1) {
            return { displayValue: `${files.length} files`, mono: true };
          }
        }
        // Simple Edit: file_path + old_string + new_string
        const fp = input.file_path || input.filePath || input.path;
        return { displayValue: fp || '', mono: true };
      }

      case 'search': {
        // Distinguish "filename-glob" tools (Glob) from "content/regex" tools
        // (Grep, codesearch, WebSearch-ish). Glob patterns are shell-style and
        // self-explanatory; quoting them looks weird. Regex / free-text queries
        // read better with quotes for visual separation from the "in <path>"
        // suffix.
        const isGlobStyle = toolName === 'Glob' || toolName === 'glob';
        const q = input.pattern || input.query || input.q;
        const p = input.path;
        const g = input.glob;
        const parts = [];
        if (q) parts.push(isGlobStyle ? q : '"' + q + '"');
        if (p) parts.push('in ' + p);          // full path, NOT basename
        if (g) parts.push('(' + g + ')');
        return { displayValue: parts.join(' '), mono: false };
      }

      case 'fetch': {
        if (input.url) return { displayValue: input.url, mono: true };
        if (Array.isArray(input.urls)) {
          return { displayValue: `${input.urls.length} URLs`, mono: false };
        }
        if (input.query) return { displayValue: '"' + input.query + '"', mono: false };
        if (input.path) return { displayValue: input.path, mono: true }; // view_image
        return { displayValue: '', mono: false };
      }

      case 'todo': {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        if (todos.length === 0) return { displayValue: '(empty)', mono: false };
        const completed = todos.filter((t) => t && t.status === 'completed').length;
        const active = todos.find((t) => t && t.status === 'in_progress');
        const label = (active && (active.activeForm || active.content))
          || (todos[0] && todos[0].content)
          || '';
        return {
          displayValue: `${completed}/${todos.length} · ${truncate(label, 50)}`,
          mono: false,
        };
      }

      case 'plan': {
        // Codex update_plan: plan is an array of {step, status}
        if (Array.isArray(input.plan)) {
          const done = input.plan.filter((s) => s && s.status === 'completed').length;
          return {
            displayValue: `${done}/${input.plan.length} steps`,
            mono: false,
          };
        }
        const text = input.plan || input.text || input.explanation || '';
        return { displayValue: truncate(text, 80), mono: false };
      }

      case 'subagent': {
        const kind = input.subagent_type || input.agent_type || input.name || '';
        const desc =
          input.description
          || input.goal
          || input.task_name
          || (typeof input.prompt === 'string' ? input.prompt : null)
          || (typeof input.message === 'string' ? input.message : null)
          || input.target
          || '';
        if (kind && desc) {
          return { displayValue: `${kind}: ${truncate(desc, 60)}`, mono: false };
        }
        return { displayValue: truncate(desc || kind, 80), mono: false };
      }

      case 'question': {
        let q = input.question;
        if (!q && Array.isArray(input.questions) && input.questions[0]) {
          q = input.questions[0].question || input.questions[0].header;
        }
        return { displayValue: truncate(q || input.reason || '', 80), mono: false };
      }

      case 'message': {
        // Hermes format: target = "platform:chat_id:thread_id"
        // Claude format: to = teammate name, summary = short text
        const target = input.target || input.to || '';
        const platform = (typeof target === 'string' && target.includes(':'))
          ? target.split(':')[0]
          : '';
        const body = input.message || input.summary || '';
        if (platform) {
          return {
            displayValue: `→ ${platform}: ${truncate(body, 60)}`,
            mono: false,
          };
        }
        if (target) {
          return { displayValue: `→ ${target}: ${truncate(body, 60)}`, mono: false };
        }
        return { displayValue: truncate(body, 80), mono: false };
      }

      case 'mcp': {
        const server = input.server || '';
        const uri = input.uri || '';
        if (server && uri) {
          return { displayValue: `${server} ${uri}`, mono: true };
        }
        if (toolName && toolName.startsWith('mcp__')) {
          // "mcp__<server>__<tool>"
          return { displayValue: toolName.slice(5).replace(/__/g, '.'), mono: true };
        }
        return { displayValue: server || uri || toolName, mono: true };
      }

      case 'unknown':
      default: {
        // Best-effort fallback: scan likely fields and pick the first string.
        const value = firstString(input, [
          'file_path', 'filePath', 'path', 'dir_path',
          'command', 'cmd', 'script',
          'query', 'pattern', 'q',
          'url', 'uri',
          'description', 'name', 'subject', 'goal',
          'message', 'prompt', 'content', 'result', 'body', 'question',
        ]);
        return { displayValue: value ? truncate(value, 80) : '', mono: false };
      }
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────
  window.ToolTaxonomy = {
    classifyTool,
    normalizeToolInput,
    parsePatchFiles,
    CATEGORY_LABELS,
    TOOL_CATEGORY,
  };
})();
