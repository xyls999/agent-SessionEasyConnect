'use strict';
const path = require('path');
const U = require('./util');

function clip(s, n = 800) {
  s = String(s == null ? '' : s);
  return s.length > n ? `${s.slice(0, n)}\n...[+${s.length - n} chars truncated]` : s;
}

function jsonShort(v, n = 400) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  return clip(s, n);
}

// ---------------------------------------------------------------------------
// Human readable renderings
// ---------------------------------------------------------------------------
function toText(ir) {
  const out = [];
  out.push(`# ${ir.agent} session ${ir.session_id}`);
  out.push(`cwd: ${ir.cwd || '-'} | created: ${U.msToIso(ir.created_at) || '-'} | model: ${ir.model || '-'}`);
  for (const m of ir.messages) {
    if (!m.parts || !m.parts.length) continue;
    const texts = [];
    const tools = [];
    for (const p of m.parts) {
      if (p.type === 'text') texts.push(p.text);
      else if (p.type === 'reasoning') texts.push(p.text ? `[reasoning] ${p.text}` : '[reasoning omitted/encrypted]');
      else if (p.type === 'tool_call') tools.push(`[tool_call ${p.name || '?'}] ${jsonShort(p.input)}`);
      else if (p.type === 'tool_result') tools.push(`[tool_result${p.is_error ? ' ERROR' : ''}] ${clip(p.output, 800)}`);
      else if (p.type === 'image') texts.push('[image]');
    }
    if (texts.length) out.push(`\n## ${String(m.role).toUpperCase()}\n${texts.join('\n')}`);
    if (tools.length) out.push(`\n## TOOL\n${tools.join('\n')}`);
  }
  return out.join('\n');
}

function toMarkdown(ir, opts = {}) {
  const out = [];
  out.push(`# Imported session (${ir.agent})`);
  out.push('');
  out.push(`- session_id: \`${ir.session_id}\``);
  out.push(`- cwd: \`${ir.cwd || '-'}\``);
  out.push(`- created: ${U.msToIso(ir.created_at) || '-'}`);
  out.push(`- model: \`${ir.model || '-'}\``);
  out.push(`- messages: ${ir.messages.length}`);
  out.push('');
  out.push('---');
  for (const m of ir.messages) {
    if (!m.parts || !m.parts.length) continue;
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) { out.push('', `**${m.role}:**`, '', p.text); }
      else if (p.type === 'reasoning') { out.push('', `**${m.role} (reasoning):**`, '', p.text ? p.text : '_[omitted]_'); }
      else if (p.type === 'tool_call') { out.push('', `**tool_call \`${p.name || '?'}\`:**`, '', '```json', jsonShort(p.input, opts.full ? Infinity : 1200), '```'); }
      else if (p.type === 'tool_result') { out.push('', `**tool_result${p.is_error ? ' (error)' : ''}:**`, '', '```', clip(p.output, opts.full ? Infinity : 1600), '```'); }
      else if (p.type === 'image') out.push('', `**${m.role}:** _[image]_`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Native store generators
// ---------------------------------------------------------------------------
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function base62(n) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function genCodex(ir) {
  const id = U.uuidv7();
  const now = new Date();
  const dir = path.join('sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  const file = `rollout-${localStamp(now)}-${id}.jsonl`;
  const winId = U.uuidv7();
  const cwd = U.winCwd(ir.cwd || process.cwd());
  const fileUri = 'file:///' + cwd.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
  let ord = 0;
  let turnId = null;
  let turnStartMs = null;
  const lines = [];
  const push = (type, payload, ts) => lines.push(JSON.stringify({ timestamp: ts || U.nowIso(), ordinal: ord++, type, payload }));
  const iso = (ms) => U.msToIso(ms) || undefined;

  push('session_meta', {
    session_id: id, id, timestamp: U.nowIso(), cwd,
    originator: 'codex-tui', cli_version: '0.154.0', source: 'cli', thread_source: 'user',
    model_provider: 'OpenAI',
    base_instructions: { text: 'Imported session via agent-session-bus.' },
    history_mode: 'paginated', context_window: { window_id: winId },
  });

  const openTurn = (ms) => {
    turnId = U.uuidv7();
    turnStartMs = ms || Date.now();
    push('turn_context', {
      turn_id: turnId, root_turn_id: turnId, cwd, workspace_roots: [cwd],
      current_date: new Date().toISOString().slice(0, 10), timezone: 'UTC',
      approval_policy: 'never', approvals_reviewer: 'user',
      sandbox_policy: { type: 'danger-full-access' }, permission_profile: { type: 'disabled' },
      model: ir.model || 'gpt-5', personality: 'pragmatic',
      collaboration_mode: { mode: 'default' }, realtime_active: false, effort: 'medium',
    }, iso(turnStartMs));
    push('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(turnStartMs / 1000), model_context_window: 258400, collaboration_mode_kind: 'default' }, iso(turnStartMs));
  };
  const closeTurn = () => {
    if (!turnId) return;
    const end = Date.now();
    push('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: null, started_at: Math.floor((turnStartMs || end) / 1000), completed_at: Math.floor(end / 1000), duration_ms: end - (turnStartMs || end) });
    turnId = null;
  };
  const item = (obj, ms) => push('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: obj, completed_at_ms: ms || Date.now() }, iso(ms));

  for (const m of ir.messages) {
    if (m.role === 'user') { closeTurn(); openTurn(m.ts); }
    else if (!turnId) openTurn(m.ts);
    for (const p of (m.parts || [])) {
      if (p.type === 'text' && p.text) {
        if (m.role === 'system') {
          push('response_item', { type: 'message', id: `msg_${U.hexId(20)}`, role: 'developer', content: [{ type: 'input_text', text: p.text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } }, iso(m.ts));
        } else if (m.role === 'user' || m.role === 'tool') {
          push('response_item', { type: 'message', id: `msg_${U.hexId(20)}`, role: 'user', content: [{ type: 'input_text', text: p.text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } }, iso(m.ts));
          item({ type: 'UserMessage', id: U.uuidv7(), content: [{ type: 'text', text: p.text, text_elements: [] }] }, m.ts);
        } else {
          push('response_item', { type: 'message', id: `msg_${U.hexId(20)}`, role: 'assistant', content: [{ type: 'output_text', text: p.text }], phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id: turnId } }, iso(m.ts));
          item({ type: 'AgentMessage', id: `msg_${U.hexId(20)}`, content: [{ type: 'Text', text: p.text }], phase: 'final_answer' }, m.ts);
        }
      } else if (p.type === 'reasoning') {
        // Do NOT emit a response_item reasoning record. Codex replays response_item
        // entries as Responses API input items, and a reasoning item without valid
        // encrypted_content is looked up by id on the server, which 404s when store=false
        // ("Item with id 'rs_...' not found"). Reasoning is not portable anyway, so keep
        // only the typed item_completed so the TUI/history still shows a placeholder.
        item({ type: 'Reasoning', id: `rs_${U.hexId(20)}`, summary_text: [], raw_content: [] }, m.ts);
      } else if (p.type === 'tool_call') {
        const callId = U.sanitizeCallId(p.id);
        push('response_item', { type: 'function_call', id: `fc_${U.hexId(20)}`, name: p.name || 'tool', arguments: JSON.stringify(p.input == null ? {} : p.input), call_id: callId, internal_chat_message_metadata_passthrough: { turn_id: turnId } }, iso(m.ts));
        const cmd = p.input && (p.input.command || p.input.cmd || p.input.shell);
        if (cmd) {
          item({
            type: 'CommandExecution', id: `exec-${U.uuidv4()}`, process_id: '0',
            command: Array.isArray(cmd) ? cmd : [String(cmd)], cwd: fileUri, parsed_cmd: [],
            source: 'unified_exec_startup', status: 'completed', stdout: '', stderr: '',
            aggregated_output: '', exit_code: 0, duration: { secs: 0, nanos: 0 }, formatted_output: '',
          }, m.ts);
        }
      } else if (p.type === 'tool_result') {
        push('response_item', { type: 'function_call_output', id: `fco_${U.hexId(20)}`, call_id: U.sanitizeCallId(p.id), output: String(p.output == null ? '' : p.output) }, iso(m.ts));
      }
    }
  }
  closeTurn();
  return { relPath: path.join(dir, file), content: lines.join('\n') + '\n', sid: id };
}

function genPi(ir, opts = {}) {
  const id = U.uuidv7();
  const iso = U.nowIso();
  const dir = path.join('sessions', U.piSessionDirName(ir.cwd || process.cwd()));
  const file = `${U.piFileStamp(iso)}_${id}.jsonl`;
  const lines = [];
  let prev = null;
  const rec = (obj) => { obj.id = U.hexId(4); obj.parentId = prev; obj.timestamp = obj.timestamp || U.nowIso(); lines.push(obj); prev = obj.id; return obj; };
  lines.push({ type: 'session', version: 3, id, timestamp: iso, cwd: ir.cwd || process.cwd() });
  let activeCharacters = 0;
  let pendingCheckpoint = null;
  let checkpoints = 0;
  // The source model/provider may not exist in Pi. Keep provenance without selecting
  // a fake model; Pi will resume with the user's configured model.
  rec({ type: 'custom', customType: 'agent-session-bus', data: { agent: ir.agent, sessionId: ir.session_id, model: ir.model || null } });
  const calls = new Map();
  const missingIds = [];
  const usedIds = new Set();
  const newCall = (p) => {
    let callId = U.sanitizeCallId(p.id);
    if (usedIds.has(callId)) callId = callId.slice(0, 47) + '_' + U.hexId(8);
    usedIds.add(callId);
    const call = { id: callId, name: p.name || 'tool' };
    if (p.id != null) calls.set(String(p.id), call);
    else missingIds.push(call);
    return call;
  };
  for (const m of ir.messages) {
    let content = [];
    const timestamp = m.ts || Date.now();
    const emit = (message) => {
      const entry = rec({ type: 'message', timestamp: U.msToIso(m.ts) || undefined, message: { ...message, timestamp } });
      if (pendingCheckpoint) { pendingCheckpoint.firstKeptEntryId = entry.id; pendingCheckpoint = null; }
      // Conservative character budget for the eventual single-text summary request:
      // JSON escaping in tool arguments plus text/thinking/results and role labels.
      activeCharacters += 128 + JSON.stringify(message.content || []).length;
    };
    const flush = () => {
      if (!content.length) return;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const msg = { role, content };
      if (role === 'assistant') {
        Object.assign(msg, { api: 'openai-responses', provider: 'imported', model: m.model || ir.model || 'imported', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });
      }
      emit(msg);
      content = [];
    };
    for (const p of (m.parts || [])) {
      if (p.type === 'text') content.push({ type: 'text', text: m.role === 'system' ? `[Imported system context]\n${p.text || ''}` : (p.text || '') });
      else if (p.type === 'reasoning' && m.role === 'assistant') content.push({ type: 'thinking', thinking: p.text || '' });
      else if (p.type === 'tool_call') {
        const call = newCall(p);
        const input = p.input == null ? {} : p.input;
        content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: input && typeof input === 'object' && !Array.isArray(input) ? input : { raw: input } });
      } else if (p.type === 'tool_result') {
        // OpenCode stores the result in the same assistant part as the call. Pi
        // requires a separate toolResult message regardless of the source role.
        flush();
        let call = p.id != null ? calls.get(String(p.id)) : null;
        if (!call && p.id == null) {
          const candidates = missingIds.filter((c) => !p.name || c.name === p.name);
          if (candidates.length === 1) { call = candidates[0]; missingIds.splice(missingIds.indexOf(call), 1); }
        }
        const output = String(p.output == null ? '' : p.output);
        if (call) {
          emit({ role: 'toolResult', toolCallId: call.id, toolName: p.name || call.name, content: [{ type: 'text', text: output }], isError: !!p.is_error });
        } else {
          // An orphan output must not be sent as an API tool response with no call.
          emit({ role: 'user', content: [{ type: 'text', text: `[Imported tool result: ${p.name || 'tool'}${p.is_error ? ' (error)' : ''}]\n${output}` }] });
        }
      } else if (p.type === 'image') content.push({ type: 'image', data: p.data || '', mimeType: p.mime || 'image/png' });
    }
    flush();
    if (m.is_summary) {
      const summary = (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text || '').join('\n').trim();
      if (summary) {
        const entry = rec({ type: 'compaction', summary, tokensBefore: Math.ceil(activeCharacters / 4), fromHook: true, details: { sourceAgent: ir.agent, sourceMessageId: m.id || null } });
        // The next emitted message becomes the kept boundary. If there is no next
        // message, the checkpoint itself denotes an empty tail (legacy Pi compatible).
        entry.firstKeptEntryId = entry.id;
        pendingCheckpoint = entry;
        activeCharacters = summary.length + 256;
        checkpoints++;
      }
    }
  }
  // Imported histories can be much larger than a normal live context. Refuse an
  // unsafe active span instead of writing a session whose first auto-compaction
  // exceeds the Responses API 10 Mi-character single-text limit. Never truncate it.
  if (activeCharacters > 8000000) {
    throw new Error(`Pi active context is too large (${activeCharacters} estimated characters after ${checkpoints} checkpoint(s)); use --mode context to archive it, or compact the source before native injection`);
  }
  // Pi also infers a saved model from assistant records. Select the configured
  // target AFTER the imported history so foreign assistant metadata cannot win.
  if (typeof opts.provider === 'string' && opts.provider && typeof opts.model === 'string' && opts.model) {
    rec({ type: 'model_change', provider: opts.provider, modelId: opts.model });
  }
  return { relPath: path.join(dir, file), content: lines.map((r) => JSON.stringify(r)).join('\n') + '\n', sid: id, activeCharacters, checkpoints };
}

function genClaude(ir) {
  const id = U.uuidv4();
  const cwd = ir.cwd || process.cwd();
  const dir = path.join('projects', U.claudeProjectKey(cwd));
  const file = `${id}.jsonl`;
  const lines = [];
  let prevUuid = null;
  const base = () => ({ parentUuid: prevUuid, logicalParentUuid: undefined, isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.270', gitBranch: '', type: 'user', uuid: U.uuidv4(), timestamp: U.nowIso() });
  const callIds = new Map();
  let lastMissingId = null;
  const emit = (r, m) => {
    if (m.ts) r.timestamp = U.msToIso(m.ts);
    lines.push(JSON.stringify(r)); prevUuid = r.uuid;
  };
  for (const m of ir.messages) {
    if (m.role === 'system') {
      const r = base(); r.type = 'system'; r.subtype = 'injected';
      r.content = (m.parts || []).map((p) => p.text || '').join('\n');
      if (m.ts) r.timestamp = U.msToIso(m.ts);
      lines.push(JSON.stringify(r)); prevUuid = r.uuid;
      continue;
    }
    let content = [];
    const flush = () => {
      if (!content.length) return;
      const r = base();
      r.type = m.role === 'assistant' ? 'assistant' : 'user';
      r.message = r.type === 'user'
        ? { role: 'user', content: content.map((p) => p.text || '').join('\n') }
        : { id: `msg_${base62(20)}`, type: 'message', role: 'assistant', model: m.model || ir.model || 'imported', content, stop_reason: content.some((p) => p.type === 'tool_use') ? 'tool_use' : 'end_turn' };
      emit(r, m);
      content = [];
    };
    for (const p of (m.parts || [])) {
      if (p.type === 'text') content.push({ type: 'text', text: p.text || '' });
      else if (p.type === 'tool_call') {
        const callId = U.sanitizeCallId(p.id, 'toolu_');
        if (p.id != null) callIds.set(String(p.id), callId);
        else lastMissingId = callId;
        const input = p.input == null ? {} : p.input;
        content.push({ type: 'tool_use', id: callId, name: p.name || 'tool', input: input && typeof input === 'object' && !Array.isArray(input) ? input : { raw: input } });
      } else if (p.type === 'tool_result') {
        flush();
        const callId = p.id != null ? callIds.get(String(p.id)) : lastMissingId;
        if (p.id == null) lastMissingId = null;
        const r = base();
        const output = String(p.output == null ? '' : p.output);
        r.message = callId
          ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text: output }], is_error: !!p.is_error }] }
          : { role: 'user', content: `[Imported tool result: ${p.name || 'tool'}]\n${output}` };
        emit(r, m);
      }
    }
    flush();
  }
  return { relPath: path.join(dir, file), content: lines.join('\n') + '\n', sid: id };
}

// `target` optionally resolves the provider/model the imported session will actually use
// when continued inside opencode (injected by src/inject.js from the user's live models).
// Without it the session would be pinned to a nonexistent "imported" provider and every
// attempt to continue the conversation would fail with "model not found"/Bad Request.
function genOpenCodeImport(ir, target) {
  const prov = (target && target.providerID) || 'imported';
  const modelID = (target && target.modelID) || ir.model || 'imported';
  const sid = `ses_${U.hexId(6)}${base62(14)}`;
  const created = ir.created_at || Date.now();
  const cwd = String(ir.cwd || process.cwd()).replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
  // Sources like Pi sessions often have no title at all; derive one from the first
  // user text so the imported session is findable in opencode's per-project list
  // instead of a pile of identical "Imported from pi" entries.
  const deriveTitle = () => {
    for (const m of ir.messages || []) {
      if (m.role !== 'user') continue;
      for (const p of m.parts || []) {
        if (p.type === 'text' && p.text && p.text.trim()) return p.text.trim().replace(/\s+/g, ' ').slice(0, 60);
      }
    }
    return null;
  };
  const title = ir.title || deriveTitle() || `Imported from ${ir.agent}`;
  const info = {
    id: sid, slug: 'imported-session', projectID: 'global', directory: cwd,
    path: 'session', title,
    agent: 'build', model: { id: modelID, providerID: prov },
    version: '1.18.30', time: { created, updated: ir.updated_at || created },
  };
  const msgModel = (m) => (target ? modelID : (m.model || ir.model || 'imported'));

  // opencode's import schema only accepts role "user" or "assistant" (no system/tool
  // messages), and tool calls/results belong to a single `tool` part with a `state`
  // machine. Drop system/developer messages and merge tool_result into the matching
  // tool_call part of the preceding assistant message.
  const messages = [];
  let lastUserId = null;
  const toolIndex = new Map();
  const partBase = (mid) => ({ id: `prt_${U.hexId(6)}${base62(14)}`, sessionID: sid, messageID: mid });
  // opencode requires tool state.input to be an object; Codex custom_tool_call carries JS
  // source as a string, so wrap non-object inputs.
  const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : { raw: v == null ? '' : String(v) };
  const toolTitle = (p) => {
    const i = p.input;
    const guess = (i && typeof i === 'object' && !Array.isArray(i)) ? (i.command || i.cmd || i.path || i.file_path || i.query || i.url) : i;
    const s = guess == null ? '' : String(guess);
    return (s || p.name || 'tool').replace(/\s+/g, ' ').slice(0, 200);
  };
  const toolState = (p, m, input, output, isError) => ({
    status: isError ? 'error' : 'completed',
    input,
    output,
    title: toolTitle(p),
    metadata: {},
    time: { start: m.ts || created, end: m.ts || created },
    ...(isError ? { error: output } : {}),
  });
  // opencode requires every assistant message to carry a parentID pointing at a user
  // message. If the transcript starts with an assistant turn (e.g. the synthetic
  // <environment_context> user message was filtered out), synthesize a placeholder user.
  const ensureUser = () => {
    if (lastUserId) return;
    const pmid = `msg_${U.hexId(6)}${base62(14)}`;
    messages.push({
      info: { id: pmid, sessionID: sid, role: 'user', agent: 'build', time: { created }, model: { providerID: prov, modelID }, summary: { diffs: [] } },
      parts: [{ ...partBase(pmid), type: 'text', text: title }],
    });
    lastUserId = pmid;
  };

  for (const m of ir.messages) {
    const role = (m.role === 'user') ? 'user' : (m.role === 'assistant' || m.role === 'tool') ? 'assistant' : null;
    if (!role) continue;

    const mid = `msg_${U.hexId(6)}${base62(14)}`;
    const parts = [];
    for (const p of (m.parts || [])) {
      if (p.type === 'text' && p.text) parts.push({ ...partBase(mid), type: 'text', text: p.text });
      else if (p.type === 'reasoning' && p.text) {
        const partTime = m.ts || created;
        parts.push({ ...partBase(mid), type: 'reasoning', text: p.text, time: { start: partTime, end: partTime } });
      }
      else if (p.type === 'image') parts.push({ ...partBase(mid), type: 'file', mime: p.mime || 'image/png', filename: 'image', url: p.data || '' });
      else if (p.type === 'tool_call') {
        const callID = U.sanitizeCallId(p.id);
        const part = { ...partBase(mid), type: 'tool', tool: p.name || 'tool', callID, state: toolState(p, m, asObject(p.input), '', false) };
        parts.push(part);
        toolIndex.set(callID, part);
      } else if (p.type === 'tool_result') {
        const callID = U.sanitizeCallId(p.id);
        const output = String(p.output == null ? '' : p.output);
        const found = toolIndex.get(callID);
        if (found) {
          found.state.output = output;
          found.state.status = p.is_error ? 'error' : 'completed';
          if (p.is_error) found.state.error = output;
        } else parts.push({ ...partBase(mid), type: 'tool', tool: p.name || 'tool', callID, state: toolState(p, m, {}, output, p.is_error) });
      }
    }
    if (!parts.length) continue; // e.g. a tool-result message already merged upward

    const minfo = { id: mid, sessionID: sid, role, agent: 'build', time: { created: m.ts || created } };
    if (role === 'assistant') {
      ensureUser();
      Object.assign(minfo, {
        parentID: lastUserId,
        mode: 'build',
        path: { cwd, root: '/' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: msgModel(m),
        providerID: prov,
        finish: 'stop',
      });
    } else {
      Object.assign(minfo, {
        model: { providerID: prov, modelID: msgModel(m) },
        summary: { diffs: [] },
      });
    }
    if (role === 'user') lastUserId = mid;
    messages.push({ info: minfo, parts });
  }

  if (!messages.length) {
    const mid = `msg_${U.hexId(6)}${base62(14)}`;
    messages.push({
      info: { id: mid, sessionID: sid, role: 'user', agent: 'build', time: { created }, model: { providerID: prov, modelID }, summary: { diffs: [] } },
      parts: [{ id: `prt_${U.hexId(6)}${base62(14)}`, sessionID: sid, messageID: mid, type: 'text', text: title }],
    });
  }

  return { content: JSON.stringify({ info, messages }, null, 2), sid, file: `${sid}.json` };
}

module.exports = { toText, toMarkdown, clip, jsonShort, genCodex, genPi, genClaude, genOpenCodeImport };
