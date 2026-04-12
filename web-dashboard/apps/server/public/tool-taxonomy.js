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
  // Signature: (toolName, input?, agent?)
  // `input` is the raw tool_input — used only by the shell-command
  // refinement step (see refineShellCommand below). Kept optional so
  // callers that only have the name can still get a base category.
  //
  // Ambiguous-name handling and shell-command heuristic refinement both
  // live here so the static TOOL_CATEGORY map can stay flat.
  function classifyTool(toolName, input, agent) {
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

    const base = TOOL_CATEGORY[toolName] || 'unknown';

    // Codex (and sometimes Claude / OpenCode) route file-reads,
    // content-searches, and even file-edits through shell commands.
    // Peek at the command string and re-classify so the user sees
    // "Read cat file.txt" (cyan) instead of a wall of "Shell" (orange).
    if (base === 'shell' && input) {
      const refined = refineShellCommand(input);
      if (refined) return refined;
    }

    return base;
  }

  // Inspect a shell command and bucket it into read / search / write /
  // edit. Returns null if the command doesn't match any specialized
  // pattern and should stay classified as plain 'shell'.
  //
  // Strategy:
  //   1. Strip a `bash -lc '…'` wrapper so we see the real payload.
  //   2. Redirection wins first — `foo > file` is always a write.
  //   3. Split the body on compound operators (|, ||, &&, ;) and scan
  //      each segment in order. The first segment that maps to a
  //      non-null sub-category wins. This lets `pwd && ls -la /root`
  //      classify as read (ls) even though pwd alone is plain shell.
  function refineShellCommand(input) {
    let cmd = input.command || input.cmd || input.script;
    if (Array.isArray(cmd)) cmd = cmd.join(' ');
    if (typeof cmd !== 'string' || !cmd.trim()) return null;

    const wrapMatch = cmd.match(/^(?:bash|sh|zsh)\s+(?:-l)?c\s+['"]?(.+?)['"]?\s*$/);
    const body = wrapMatch ? wrapMatch[1] : cmd;

    // Redirection across the whole body always wins.
    if (/(?:^|\s)>\s*[^\s|&>]/.test(body) || /(?:^|\s)>>\s*[^\s|&>]/.test(body)) {
      return 'write';
    }

    const segments = body
      .split(/\s*(?:\|\|?|&&|[;|])\s*/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const seg of segments) {
      const refined = refineSegmentBin(seg);
      if (refined) return refined;
    }
    return null;
  }

  function refineSegmentBin(seg) {
    if (!seg) return null;
    const bin = seg.split(/\s+/)[0].replace(/^['"]|['"]$/g, '');
    if (!bin) return null;

    // In-place edits via sed -i / awk -i inplace / apply_patch / patch
    if (bin === 'sed' && /(?:^|\s)-i(?:\s|$|\b)/.test(seg)) return 'edit';
    if (bin === 'awk' && /-i\s+inplace/.test(seg)) return 'edit';
    if (bin === 'apply_patch') return 'edit';
    if (bin === 'patch') return 'edit';

    // Read-like: content / line-range / preview
    if (/^(cat|head|tail|nl|less|more|bat|sed|awk|strings|od|xxd|hexdump)$/.test(bin)) {
      return 'read';
    }

    // Directory / file listing — semantic subset of "read".
    // `pwd` is intentionally excluded — it's a meta "where am I" query.
    if (/^(ls|dir|tree|find|stat|file|wc|realpath|readlink|basename|dirname)$/.test(bin)) {
      return 'read';
    }

    // Search
    if (/^(grep|egrep|fgrep|rg|ack|ag|ripgrep)$/.test(bin)) return 'search';

    // git sub-commands that are read/search ops. We have to walk past
    // any global flags — particularly `-C <path>` and `-c key=val` which
    // take an argument — to find the actual sub-command token.
    if (bin === 'git') {
      const tokens = seg.split(/\s+/);
      let idx = 1;
      while (idx < tokens.length) {
        const t = tokens[idx];
        if (t === '-C' || t === '-c') { idx += 2; continue; }
        if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) { idx += 1; continue; }
        if (t === '--git-dir' || t === '--work-tree') { idx += 2; continue; }
        if (t.startsWith('-')) { idx += 1; continue; }
        break;
      }
      const sub = tokens[idx];
      if (sub && /^(diff|log|show|status|blame|ls-files|grep|rev-parse|describe|branch|remote)$/.test(sub)) {
        return 'search';
      }
    }

    if (/^tee$/.test(bin)) return 'write';

    return null;
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

  // Shell-origin detection: this tool_input carries a command field,
  // meaning the event was upgraded from shell category (e.g. Codex's
  // Bash-for-everything pattern). We show the command verbatim so the
  // user still sees exactly what ran, but the row wears the upgraded
  // category's color/label.
  //
  // Includes `code` (Hermes execute_code runs Python) so a shell-category
  // event for execute_code can still display meaningfully. Does NOT
  // include `chars` because Codex write_stdin is handled by its own
  // dedicated branch in the shell case (see normalizeToolInput).
  function isShellOrigin(input) {
    if (!input) return false;
    return (
      typeof input.command === 'string'
      || typeof input.cmd === 'string'
      || Array.isArray(input.cmd)
      || typeof input.script === 'string'
      || typeof input.code === 'string'
    );
  }

  function shellCommandString(input) {
    const cmd = input.command || input.cmd || input.script || input.code;
    if (Array.isArray(cmd)) return cmd.join(' ');
    return typeof cmd === 'string' ? cmd : '';
  }

  // ─── Normalization per category ────────────────────────────────────────
  // Returns { displayValue, mono, pill? }
  //   displayValue  — the text shown in the tool row's right column
  //   mono          — true means render in monospace (for paths, commands, diffs)
  //   pill          — true means wrap the value in a dark terminal-pill
  //                    with a green `>_` prefix. Applied to shell commands
  //                    (native `Bash` / `exec_command` etc. OR shell-origin
  //                    refined categories like Codex `cat` upgraded to read)
  //                    but NOT to `write_stdin` (semantically different) or
  //                    to events that have a description field (we prefer
  //                    the human-readable description over the raw command).
  function normalizeToolInput(category, toolName, input) {
    input = input || {};

    // For categories that can be reached BOTH natively (Claude Read, OC
    // grep, etc.) AND via shell-refinement (Codex `cat file`, `rg query`),
    // show the command verbatim when it's a shell-origin input. Raw
    // command beats any heuristic path extraction — the user always
    // wants to see exactly what Codex asked the shell to do.
    if (
      (category === 'read' || category === 'search' || category === 'write' || category === 'edit')
      && isShellOrigin(input)
    ) {
      const cmd = shellCommandString(input);
      const desc = input.description;
      return {
        displayValue: desc || cmd,
        mono: !desc,
        // Pill only when we're showing the raw command (no description).
        // If we show a friendly description, keep it as plain text.
        pill: !desc && !!cmd,
      };
    }

    switch (category) {
      case 'shell': {
        // Codex write_stdin — writes bytes to a running unified-exec
        // session, NOT a new shell command. The `chars` field can contain
        // control characters / newlines / etc, so escape whitespace for
        // single-line display. Never gets a terminal pill because
        // semantically it's not "execute this command".
        if (toolName === 'write_stdin') {
          const sid = input.session_id;
          const raw = typeof input.chars === 'string' ? input.chars : '';
          const preview = raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
          const visible = preview.replace(/\n/g, '↵ ').replace(/\t/g, '⇥ ');
          return {
            displayValue: sid != null ? `→ session ${sid}: ${visible}` : visible,
            mono: true,
          };
        }
        const cmdRaw = input.command || input.cmd || input.script || input.code;
        const cmd = Array.isArray(cmdRaw) ? cmdRaw.join(' ') : cmdRaw;
        const desc = input.description;
        return {
          displayValue: desc || cmd || '',
          mono: !desc && !!cmd,
          pill: !desc && !!cmd,
        };
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
        // Claude NotebookEdit: notebook_path + cell_id + new_source + cell_type
        // (NO old_string — you target a cell by id and replace/insert/delete it)
        if (toolName === 'NotebookEdit' || input.notebook_path) {
          const np = input.notebook_path || input.file_path;
          const cell = input.cell_id;
          const mode = input.edit_mode || 'replace';
          if (cell) {
            return {
              displayValue: `${np || ''} [${mode} cell ${cell}]`,
              mono: true,
            };
          }
          return { displayValue: np || '', mono: true };
        }
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
        // (notebook_path is also checked as a last-ditch fallback for any
        // edge case where NotebookEdit is dispatched through here)
        const fp = input.file_path || input.filePath || input.path || input.notebook_path;
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
        // Cancelled counts separately — same math as renderTodoDetail so
        // the compact row and the expanded checklist agree on the
        // completion ratio. OpenCode and Hermes both have a `cancelled`
        // status; Claude doesn't, so for Claude sessions cancelled is 0
        // and this behaves identically to the old single-denominator form.
        const completed = todos.filter((t) => t && t.status === 'completed').length;
        const cancelled = todos.filter((t) => t && t.status === 'cancelled').length;
        const liveTotal = todos.length - cancelled;
        // All items cancelled — no meaningful progress ratio.
        if (liveTotal === 0) {
          return { displayValue: `(${cancelled} cancelled)`, mono: false };
        }
        // Pick an active or first non-cancelled todo for the label so we
        // don't headline a crossed-out task.
        const active = todos.find((t) => t && t.status === 'in_progress');
        const firstLive = todos.find((t) => t && t.status !== 'cancelled');
        const label =
          (active && (active.activeForm || active.content))
          || (firstLive && firstLive.content)
          || '';
        const suffix = cancelled ? ` ✗${cancelled}` : '';
        return {
          displayValue: `${completed}/${liveTotal}${suffix} · ${truncate(label, 50)}`,
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
        // Codex wait_agent — blocking wait on one or more agent ids.
        // targets is an array; format as "wait: a, b, c".
        if (Array.isArray(input.targets) && input.targets.length) {
          const joined = input.targets.join(', ');
          return {
            displayValue: `wait: ${truncate(joined, 70)}`,
            mono: false,
          };
        }
        // Codex spawn_agents_on_csv — batch run over a CSV file
        if (input.csv_path) {
          const instruction = input.instruction || '';
          return {
            displayValue: `csv ${input.csv_path}${instruction ? ': ' + truncate(instruction, 40) : ''}`,
            mono: false,
          };
        }

        const kind =
          input.subagent_type
          || input.agent_type
          || input.name
          || '';

        // Description / prompt / target across all known subagent tools.
        // Order matters: structured labels (description, goal, task_name)
        // beat free-text (prompt, message), which beat bare identifiers
        // (target, path_prefix, id, task_id).
        const desc =
          input.description
          || input.goal
          || input.task_name
          || input.instruction
          || (typeof input.prompt === 'string' ? input.prompt : null)
          || (typeof input.message === 'string' ? input.message : null)
          || input.target
          || input.path_prefix
          || input.task_id
          || input.id
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
