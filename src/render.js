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

function toMarkdown(ir) {
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
      else if (p.type === 'tool_call') { out.push('', `**tool_call \`${p.name || '?'}\`:**`, '', '```json', jsonShort(p.input, 1200), '```'); }
      else if (p.type === 'tool_result') { out.push('', `**tool_result${p.is_error ? ' (error)' : ''}:**`, '', '```', clip(p.output, 1600), '```'); }
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
        const rid = `rs_${U.hexId(20)}`;
        push('response_item', { type: 'reasoning', id: rid, summary: [], content: null, encrypted_content: '' }, iso(m.ts));
        item({ type: 'Reasoning', id: rid, summary_text: [], raw_content: [] }, m.ts);
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

function genPi(ir) {
  const id = U.uuidv7();
  const iso = U.nowIso();
  const dir = path.join('sessions', U.piSessionDirName(ir.cwd || process.cwd()));
  const file = `${U.piFileStamp(iso)}_${id}.jsonl`;
  const lines = [];
  let prev = null;
  const rec = (obj) => { obj.id = U.hexId(4); obj.parentId = prev; obj.timestamp = obj.timestamp || U.nowIso(); lines.push(JSON.stringify(obj)); prev = obj.id; };
  lines.push(JSON.stringify({ type: 'session', version: 3, id, timestamp: iso, cwd: ir.cwd || process.cwd() }));
  prev = null;
  rec({ type: 'model_change', provider: 'imported', modelId: ir.model || 'imported' });
  for (const m of ir.messages) {
    if (m.role === 'tool') {
      for (const p of (m.parts || [])) {
        if (p.type !== 'tool_result') continue;
        rec({
          type: 'message', timestamp: U.msToIso(m.ts) || undefined,
          message: { role: 'toolResult', toolCallId: p.id || `call_${base62(12)}`, toolName: p.name || 'tool', content: [{ type: 'text', text: String(p.output == null ? '' : p.output) }], isError: !!p.is_error, timestamp: m.ts || Date.now() },
        });
      }
      continue;
    }
    const content = [];
    for (const p of (m.parts || [])) {
      if (p.type === 'text') content.push({ type: 'text', text: p.text });
      else if (p.type === 'reasoning') content.push({ type: 'thinking', thinking: p.text || '' });
      else if (p.type === 'tool_call') content.push({ type: 'toolCall', id: p.id || `call_${base62(12)}`, name: p.name || 'tool', arguments: p.input == null ? {} : p.input });
      else if (p.type === 'image') content.push({ type: 'image', data: p.data || '', mimeType: p.mime || 'image/png' });
    }
    if (!content.length) continue;
    const msg = { role: m.role === 'user' ? 'user' : 'assistant', content, timestamp: m.ts || Date.now() };
    if (msg.role === 'assistant') {
      Object.assign(msg, { api: 'openai-responses', provider: 'imported', model: m.model || ir.model || 'imported', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' });
    }
    rec({ type: 'message', timestamp: U.msToIso(m.ts) || undefined, message: msg });
  }
  return { relPath: path.join(dir, file), content: lines.join('\n') + '\n', sid: id };
}

function genClaude(ir) {
  const id = U.uuidv4();
  const cwd = ir.cwd || process.cwd();
  const dir = path.join('projects', U.claudeProjectKey(cwd));
  const file = `${id}.jsonl`;
  const lines = [];
  let prevUuid = null;
  const base = () => ({ parentUuid: prevUuid, logicalParentUuid: undefined, isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.270', gitBranch: '', type: 'user', uuid: U.uuidv4(), timestamp: U.nowIso() });
  for (const m of ir.messages) {
    if (m.role === 'tool') {
      for (const p of (m.parts || [])) {
        if (p.type !== 'tool_result') continue;
        const r = base();
        r.type = 'user';
        r.message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: U.sanitizeCallId(p.id, 'toolu_'), content: [{ type: 'text', text: String(p.output == null ? '' : p.output) }], is_error: !!p.is_error }] };
        if (m.ts) r.timestamp = U.msToIso(m.ts);
        lines.push(JSON.stringify(r)); prevUuid = r.uuid;
      }
      continue;
    }
    if (m.role === 'system') {
      const r = base(); r.type = 'system'; r.subtype = 'injected';
      r.content = (m.parts || []).map((p) => p.text || '').join('\n');
      if (m.ts) r.timestamp = U.msToIso(m.ts);
      lines.push(JSON.stringify(r)); prevUuid = r.uuid;
      continue;
    }
    const r = base();
    r.type = m.role === 'user' ? 'user' : 'assistant';
    if (r.type === 'user') {
      const text = (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      r.message = { role: 'user', content: text };
    } else {
      const content = [];
      for (const p of (m.parts || [])) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text });
        else if (p.type === 'tool_call') content.push({ type: 'tool_use', id: U.sanitizeCallId(p.id, 'toolu_'), name: p.name || 'tool', input: p.input == null ? {} : p.input });
      }
      if (!content.length) continue;
      r.message = { id: `msg_${base62(20)}`, type: 'message', role: 'assistant', model: m.model || ir.model || 'imported', content, stop_reason: 'end_turn' };
    }
    if (m.ts) r.timestamp = U.msToIso(m.ts);
    lines.push(JSON.stringify(r)); prevUuid = r.uuid;
  }
  return { relPath: path.join(dir, file), content: lines.join('\n') + '\n', sid: id };
}

function genOpenCodeImport(ir) {
  const sid = `ses_${U.hexId(6)}${base62(14)}`;
  const created = ir.created_at || Date.now();
  const info = {
    id: sid, slug: 'imported-session', projectID: 'global', directory: ir.cwd || process.cwd(),
    path: 'session', title: ir.title || `Imported from ${ir.agent}`,
    agent: 'build', model: { id: ir.model || 'imported', providerID: 'imported' },
    version: '1.18.30', time: { created, updated: ir.updated_at || created },
  };
  let parent = null;
  const messages = ir.messages.map((m) => {
    const mid = `msg_${U.hexId(6)}${base62(14)}`;
    const parts = [];
    for (const p of (m.parts || [])) {
      const baseP = { id: `prt_${U.hexId(6)}${base62(14)}`, sessionID: sid, messageID: mid };
      if (p.type === 'text') parts.push({ ...baseP, type: 'text', text: p.text });
      else if (p.type === 'reasoning') parts.push({ ...baseP, type: 'reasoning', text: p.text || '' });
      else if (p.type === 'tool_call') parts.push({ ...baseP, type: 'tool', tool: p.name || 'tool', callID: U.sanitizeCallId(p.id), state: { status: 'completed', input: p.input == null ? {} : p.input, output: '' } });
      else if (p.type === 'tool_result') parts.push({ ...baseP, type: 'tool', tool: p.name || 'tool', callID: U.sanitizeCallId(p.id), state: { status: p.is_error ? 'error' : 'completed', input: {}, output: String(p.output == null ? '' : p.output) } });
    }
    const role = m.role === 'tool' ? 'user' : m.role;
    const minfo = { id: mid, sessionID: sid, role, agent: 'build', time: { created: m.ts || created } };
    if (role === 'assistant') {
      Object.assign(minfo, {
        parentID: parent || undefined,
        mode: 'build',
        path: { cwd: ir.cwd || process.cwd(), root: '/' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: m.model || ir.model || 'imported',
        providerID: 'imported',
        finish: 'stop',
      });
    } else {
      Object.assign(minfo, {
        model: { providerID: 'imported', modelID: m.model || ir.model || 'imported' },
        summary: { diffs: [] },
      });
    }
    if (role === 'user' || role === 'assistant') parent = mid;
    return { info: minfo, parts };
  });
  return { content: JSON.stringify({ info, messages }, null, 2), sid, file: `${sid}.json` };
}

module.exports = { toText, toMarkdown, clip, jsonShort, genCodex, genPi, genClaude, genOpenCodeImport };
