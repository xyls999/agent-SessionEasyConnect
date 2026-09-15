'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();

function roots() {
  return {
    codex: process.env.CODEX_HOME || path.join(HOME, '.codex'),
    claude: process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'),
    pi: process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent'),
    opencode: process.env.OPENCODE_DATA || path.join(HOME, '.local', 'share', 'opencode'),
  };
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function readJsonl(file) {
  const rows = [];
  for (const line of readLines(file)) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* skip malformed */ }
  }
  return rows;
}

function firstJson(file) {
  for (const line of readLines(file)) {
    const s = line.trim();
    if (!s) continue;
    try { return JSON.parse(s); } catch { return null; }
  }
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function uuidv4() { return crypto.randomUUID(); }

function uuidv7() {
  const b = crypto.randomBytes(16);
  let ms = BigInt(Date.now());
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function hexId(bytes = 4) { return crypto.randomBytes(bytes).toString('hex'); }

// OpenAI Responses API requires tool call ids to match [A-Za-z0-9_-] and be <= 64 chars.
// Pi stores composite ids like "call_xxx|fc_yyy" (83 chars) which trips a 400 on resume.
// Normalize deterministically so a call and its output still pair up.
function sanitizeCallId(id, prefix = 'call_') {
  let s = id == null ? '' : String(id);
  if (s.includes('|')) s = s.split('|')[0];
  s = s.replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) s = prefix + hexId(12);
  if (s.length > 64) s = s.slice(0, 64);
  return s;
}

function nowIso() { return new Date().toISOString(); }

function isoMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function anyMs(v) { return isoMs(v); }

function msToIso(ms) {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

function fmtTime(ms) {
  if (ms == null) return '-';
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', 'Z');
}

// Claude Code project directory naming: non [a-zA-Z0-9] -> '-'
function claudeProjectKey(cwd) {
  const sanitized = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  const h = crypto.createHash('sha256').update(cwd).digest('hex');
  let num = BigInt('0x' + h.slice(0, 12));
  if (num > (1n << 63n)) num = (1n << 64n) - num;
  return `${sanitized.slice(0, 200)}-${num.toString(36)}`;
}

// Pi session directory naming: "--" + cwd with [:\/] -> "-" + "--"
function piSessionDirName(cwd) {
  return '--' + String(cwd).replace(/[:\\/]/g, '-') + '--';
}

// Pi filename: iso timestamp with ':' and '.' -> '-'
function piFileStamp(iso) {
  return String(iso).replace(/[:.]/g, '-');
}

// Codex stores cwd as a Windows extended-length path ("\\?\E:\path", backslashes).
// Opencode/Pi/Claude may hand us "E:/path"; normalize so Codex's resume picker
// (which filters on cwd) matches the injected thread.
function winCwd(p) {
  if (!p) return p;
  let s = String(p).replace(/\//g, '\\');
  if (s.startsWith('\\\\?\\')) return s;
  if (s.startsWith('\\\\.\\')) return s;
  return '\\\\?\\' + s;
}

function newIR(init) {
  return Object.assign({
    schema: 'agent-session-bus/v1',
    agent: null,
    session_id: null,
    cwd: null,
    created_at: null,
    updated_at: null,
    title: null,
    model: null,
    source: null,
    messages: [],
  }, init || {});
}

function textOf(part) {
  if (!part) return '';
  if (part.type === 'text') return part.text || '';
  return '';
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = {
  HOME, roots, walk, readLines, readJsonl, firstJson, ensureDir,
  uuidv4, uuidv7, hexId, nowIso, isoMs, anyMs, msToIso, fmtTime, sanitizeCallId,
  claudeProjectKey, piSessionDirName, piFileStamp, newIR, textOf, safeJson, winCwd,
};
