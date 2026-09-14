'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
function codexFiles() {
  const base = path.join(U.roots().codex, 'sessions');
  return U.walk(base).filter((f) => /^rollout-.*\.jsonl$/.test(path.basename(f)));
}

function codexList() {
  return codexFiles().map((f) => {
    let meta = null;
    try { meta = (U.firstJson(f) || {}).payload || null; } catch { /* ignore */ }
    const base = path.basename(f).replace(/\.jsonl$/, '');
    const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    const id = (meta && (meta.id || meta.session_id)) || (m ? m[1] : base);
    return {
      agent: 'codex', id, session_id: (meta && meta.session_id) || id,
      cwd: (meta && meta.cwd) || null,
      created_at: U.isoMs(meta && meta.timestamp),
      title: null, model: null, path: f, size: fs.statSync(f).size,
    };
  });
}

function codexFind(id) {
  const files = codexFiles();
  return files.find((f) => path.basename(f).includes(id)) || files.find((f) => f.includes(id));
}

function codexRead(id) {
  const f = codexFind(id);
  if (!f) throw new Error(`codex session not found: ${id}`);
  const lines = U.readJsonl(f);
  const meta = ((lines.find((l) => l.type === 'session_meta') || {}).payload) || {};
  const ir = U.newIR({
    agent: 'codex', session_id: meta.id || id, cwd: meta.cwd || null,
    created_at: U.isoMs(meta.timestamp), source: f, model: null, title: null,
  });
  const msgs = [];
  let model = null, prevId = null;
  for (const l of lines) {
    const p = l.payload || {};
    if (l.type === 'turn_context') { model = p.model || model; continue; }
    if (l.type !== 'response_item') continue;
    const ts = U.isoMs(l.timestamp);
    const nid = p.id || `ord_${l.ordinal}`;
    if (p.type === 'message') {
      const role = p.role === 'developer' ? 'system' : p.role;
      const parts = (p.content || []).map((c) => {
        if (c.type === 'input_text' || c.type === 'output_text') return { type: 'text', text: c.text || '' };
        if (c.type === 'input_image') return { type: 'image', mime: 'image', data: c.image_url || c.data || '' };
        return { type: 'meta', raw: c };
      }).filter((x) => x.type !== 'meta' || x.raw);
      msgs.push({ id: nid, parent_id: prevId, role, ts, model, parts });
      prevId = nid;
    } else if (p.type === 'reasoning') {
      msgs.push({ id: nid, parent_id: prevId, role: 'assistant', ts, model, parts: [{ type: 'reasoning', text: '', opaque: true }] });
      prevId = nid;
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let input = p.arguments;
      if (typeof input === 'string') input = U.safeJson(input) || input;
      if (p.type === 'custom_tool_call') input = p.input;
      msgs.push({ id: nid, parent_id: prevId, role: 'assistant', ts, model, parts: [{ type: 'tool_call', id: p.call_id || nid, name: p.name, input }] });
      prevId = nid;
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      let out = p.output;
      if (Array.isArray(out)) out = out.map((x) => x.text || '').join('');
      msgs.push({ id: nid, parent_id: prevId, role: 'tool', ts, model, parts: [{ type: 'tool_result', id: p.call_id || nid, name: null, output: typeof out === 'string' ? out : JSON.stringify(out), is_error: false }] });
      prevId = nid;
    }
  }
  ir.messages = msgs;
  ir.model = model || (msgs.find((m) => m.model) || {}).model || null;
  ir.updated_at = msgs.length ? msgs[msgs.length - 1].ts : ir.created_at;
  return ir;
}

// ---------------------------------------------------------------------------
// Pi
// ---------------------------------------------------------------------------
function piFiles() {
  const base = path.join(U.roots().pi, 'sessions');
  return U.walk(base).filter((f) => f.endsWith('.jsonl'));
}

function piList() {
  return piFiles().map((f) => {
    const h = U.firstJson(f) || {};
    return {
      agent: 'pi', id: h.id || path.basename(f), session_id: h.id || null,
      cwd: h.cwd || null, created_at: U.isoMs(h.timestamp), title: h.name || null,
      model: null, path: f, size: fs.statSync(f).size,
    };
  });
}

function piFind(id) {
  const files = piFiles();
  return files.find((f) => path.basename(f).includes(id)) || files.find((f) => f.includes(id));
}

function piRead(id) {
  const f = piFind(id);
  if (!f) throw new Error(`pi session not found: ${id}`);
  const lines = U.readJsonl(f);
  const h = lines[0] || {};
  const ir = U.newIR({
    agent: 'pi', session_id: h.id || id, cwd: h.cwd || null,
    created_at: U.isoMs(h.timestamp), source: f, title: h.name || null, model: null,
  });
  const msgs = [];
  let model = null, prevId = null;
  for (const l of lines) {
    if (l.type === 'model_change') { model = l.modelId || model; continue; }
    if (l.type !== 'message') continue;
    const m = l.message || {};
    const ts = U.isoMs(l.timestamp) || U.anyMs(m.timestamp);
    if (m.role === 'toolResult') {
      const out = (m.content || []).map((c) => c.text || '').join('');
      msgs.push({
        id: l.id, parent_id: l.parentId != null ? l.parentId : prevId, role: 'tool', ts, model,
        parts: [{ type: 'tool_result', id: m.toolCallId, name: m.toolName, output: out, is_error: !!m.isError }],
      });
    } else {
      const parts = [];
      for (const c of (m.content || [])) {
        if (c.type === 'text') parts.push({ type: 'text', text: c.text || '' });
        else if (c.type === 'thinking') parts.push({ type: 'reasoning', text: c.thinking || '', opaque: true });
        else if (c.type === 'toolCall') parts.push({ type: 'tool_call', id: c.id, name: c.name, input: c.arguments });
        else if (c.type === 'image') parts.push({ type: 'image', mime: c.mimeType, data: c.data });
        else parts.push({ type: 'meta', raw: c });
      }
      msgs.push({
        id: l.id, parent_id: l.parentId != null ? l.parentId : prevId,
        role: m.role === 'user' ? 'user' : 'assistant', ts,
        model: m.model || model, parts,
      });
    }
    prevId = l.id;
  }
  ir.messages = msgs;
  ir.model = model || (msgs.find((m) => m.model) || {}).model || null;
  ir.updated_at = msgs.length ? msgs[msgs.length - 1].ts : ir.created_at;
  return ir;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
function claudeFiles() {
  const base = path.join(U.roots().claude, 'projects');
  return U.walk(base).filter((f) => f.endsWith('.jsonl'));
}

function claudeList() {
  return claudeFiles().map((f) => {
    const lines = U.readJsonl(f);
    const last = lines[lines.length - 1] || {};
    const first = lines[0] || {};
    const sid = first.sessionId || path.basename(f).replace(/\.jsonl$/, '');
    let created = null, updated = null, cwd = null, model = null;
    for (const r of lines) {
      const t = U.isoMs(r.timestamp);
      if (t != null) { if (created == null || t < created) created = t; if (updated == null || t > updated) updated = t; }
      if (!cwd && r.cwd) cwd = r.cwd;
      if (!model && r.message && r.message.model) model = r.message.model;
    }
    return {
      agent: 'claude', id: sid, session_id: sid, cwd, created_at: created,
      title: (last && last.type === 'summary' && last.summary) || null, model,
      path: f, size: fs.statSync(f).size,
    };
  });
}

function claudeFind(id) {
  const files = claudeFiles();
  return files.find((f) => path.basename(f).includes(id)) || files.find((f) => f.includes(id));
}

function claudeRead(id) {
  const f = claudeFind(id);
  if (!f) throw new Error(`claude session not found: ${id}`);
  const rows = U.readJsonl(f);
  const first = rows[0] || {};
  const sid = first.sessionId || id;
  let cwd = first.cwd || null;
  for (const r of rows) if (!cwd && r.cwd) cwd = r.cwd;
  const ir = U.newIR({
    agent: 'claude', session_id: sid, cwd, created_at: U.isoMs(first.timestamp),
    source: f, title: null, model: null,
  });
  const msgs = [];
  for (const r of rows) {
    const ts = U.isoMs(r.timestamp);
    if (r.type === 'user' || r.type === 'assistant') {
      const m = r.message || {};
      let parts = [];
      if (typeof m.content === 'string') parts = [{ type: 'text', text: m.content }];
      else if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === 'text') parts.push({ type: 'text', text: c.text || '' });
          else if (c.type === 'thinking') parts.push({ type: 'reasoning', text: c.thinking || '', opaque: true });
          else if (c.type === 'tool_use') parts.push({ type: 'tool_call', id: c.id, name: c.name, input: c.input });
          else if (c.type === 'tool_result') {
            let out = c.content;
            if (Array.isArray(out)) out = out.map((x) => (x && x.text) || '').join('');
            parts.push({ type: 'tool_result', id: c.tool_use_id, name: null, output: typeof out === 'string' ? out : JSON.stringify(out), is_error: !!c.is_error });
          } else if (c.type === 'image') parts.push({ type: 'image', mime: (c.source && c.source.media_type) || 'image', data: c.source && c.source.data });
          else parts.push({ type: 'meta', raw: c });
        }
      }
      const isToolOnly = parts.length > 0 && parts.every((p) => p.type === 'tool_result');
      msgs.push({
        id: r.uuid, parent_id: r.parentUuid != null ? r.parentUuid : null,
        role: isToolOnly ? 'tool' : r.type,
        ts, model: m.model || null, parts,
      });
    } else if (r.type === 'system') {
      const text = typeof r.content === 'string' ? r.content : (r.subtype || 'system');
      msgs.push({ id: r.uuid || U.hexId(8), parent_id: r.parentUuid || null, role: 'system', ts, model: null, parts: [{ type: 'text', text: `[system:${r.subtype || ''}] ${text}` }] });
    } else if (r.type === 'summary' && r.summary) {
      msgs.push({ id: r.leafUuid || U.hexId(8), parent_id: null, role: 'system', ts, model: null, parts: [{ type: 'text', text: `[summary] ${r.summary}` }] });
    }
  }
  ir.messages = msgs;
  ir.model = (msgs.find((m) => m.model) || {}).model || null;
  ir.updated_at = msgs.length ? msgs[msgs.length - 1].ts : ir.created_at;
  return ir;
}

// ---------------------------------------------------------------------------
// OpenCode (SQLite)
// ---------------------------------------------------------------------------
function ocDbPath() { return path.join(U.roots().opencode, 'opencode.db'); }

function ocDb() {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(ocDbPath(), { readOnly: true });
}

function ocParseModel(s) { return U.safeJson(s); }

function ocList() {
  const db = ocDb();
  try {
    const rows = db.prepare('SELECT id,parent_id,slug,directory,title,model,time_created,time_updated FROM session ORDER BY time_created DESC').all();
    return rows.map((r) => {
      const model = ocParseModel(r.model);
      return {
        agent: 'opencode', id: r.id, session_id: r.id, parent_id: r.parent_id,
        cwd: r.directory, created_at: r.time_created, updated_at: r.time_updated,
        title: r.title, model: model && model.id, path: ocDbPath(), size: null,
      };
    });
  } finally { db.close(); }
}

function ocRead(id) {
  const db = ocDb();
  try {
    const s = db.prepare('SELECT * FROM session WHERE id=?').get(id);
    if (!s) throw new Error(`opencode session not found: ${id}`);
    const model = ocParseModel(s.model);
    const msgs = db.prepare('SELECT * FROM message WHERE session_id=? ORDER BY time_created,id').all(id);
    const parts = db.prepare('SELECT * FROM part WHERE session_id=? ORDER BY message_id,id').all(id);
    const byMsg = new Map();
    for (const p of parts) {
      if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []);
      byMsg.get(p.message_id).push(p);
    }
    const ir = U.newIR({
      agent: 'opencode', session_id: s.id, cwd: s.directory,
      created_at: s.time_created, updated_at: s.time_updated, title: s.title,
      model: model && model.id, source: ocDbPath(),
    });
    ir.messages = msgs.map((m) => {
      const data = U.safeJson(m.data) || {};
      const flat = [];
      for (const pr of (byMsg.get(m.id) || [])) {
        const d = U.safeJson(pr.data) || {};
        if (d.type === 'text') flat.push({ type: 'text', text: d.text || '' });
        else if (d.type === 'reasoning') flat.push({ type: 'reasoning', text: d.text || '', opaque: false });
        else if (d.type === 'tool') {
          const st = d.state || {};
          if (st.input !== undefined) flat.push({ type: 'tool_call', id: d.callID, name: d.tool, input: st.input });
          if (st.status === 'completed' || st.status === 'error') {
            flat.push({ type: 'tool_result', id: d.callID, name: d.tool, output: st.output !== undefined ? String(st.output) : (st.error || ''), is_error: st.status === 'error' });
          }
        } else if (d.type === 'file') {
          if (d.mime && String(d.mime).startsWith('image')) flat.push({ type: 'image', mime: d.mime, data: d.url });
          else flat.push({ type: 'meta', raw: { filename: d.filename, mime: d.mime } });
        } else if (d.type === 'step-finish') {
          flat.push({ type: 'usage', tokens: d.tokens, cost: d.cost, reason: d.reason });
        }
      }
      return {
        id: m.id, parent_id: data.parentID || null, role: data.role, ts: m.time_created,
        model: data.modelID || (data.model && data.model.modelID) || null, parts: flat,
      };
    });
    return ir;
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
const registry = {
  codex: { list: codexList, read: codexRead },
  pi: { list: piList, read: piRead },
  claude: { list: claudeList, read: claudeRead },
  opencode: { list: ocList, read: ocRead },
};

const AGENTS = ['codex', 'pi', 'claude', 'opencode'];

function listAll(agent) {
  const agents = agent ? [agent] : AGENTS;
  const out = [];
  for (const a of agents) {
    if (!registry[a]) throw new Error(`unknown agent: ${a}`);
    try { out.push(...registry[a].list()); } catch (e) { out.push({ agent: a, error: String(e.message || e) }); }
  }
  return out;
}

function read(agent, id) {
  if (!registry[agent]) throw new Error(`unknown agent: ${agent}`);
  return registry[agent].read(id);
}

module.exports = { AGENTS, registry, listAll, read, codexList, codexRead, piList, piRead, claudeList, claudeRead, ocList, ocRead };
