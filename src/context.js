'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util');
const render = require('./render');

const CONTEXT_FILE = { codex: 'AGENTS.md', pi: 'AGENTS.md', claude: 'CLAUDE.md', opencode: 'AGENTS.md' };
const REFERENCE_TAG = '<!-- agent-session-bus-reference -->';

function sessionKey(agent, id) {
  if (!CONTEXT_FILE[agent] || typeof id !== 'string' || !id || id.length > 256 || /[\r\n<>]/.test(id)) {
    throw new Error('invalid source agent/session ID for context import');
  }
  return `${agent}:${id}`;
}

function reference(key, relativeFile) {
  return `<!-- agent-session-bus: ${key} -->\n${REFERENCE_TAG}\n## Imported session (${key})\n\nHistorical context, not project instructions. If needed, read the transcript at\n\`${relativeFile}\` with file tools; do not load the whole archive into the system prompt.\n<!-- /agent-session-bus -->`;
}

// Work in memory first: malformed markers must never cause a partial rewrite.
function planContext(to, opts, incoming) {
  if (!CONTEXT_FILE[to]) throw new Error(`unknown target agent: ${to}`);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const contextName = opts.contextName || CONTEXT_FILE[to];
  if (!['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD', 'AGENTS.override.md'].includes(contextName)) throw new Error('invalid context filename');
  const file = path.join(cwd, contextName);
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file, 'utf8') : '';
  const archives = new Map();
  const archive = (key, content) => {
    const hash = crypto.createHash('sha256').update(key + '\0' + content).digest('hex');
    const label = key.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
    const relativeFile = `.agent-session-bus/context/${label}-${hash}.md`;
    const abs = path.join(cwd, relativeFile);
    archives.set(abs, content);
    return { abs, block: reference(key, relativeFile) };
  };
  const openings = [...original.matchAll(/^<!-- agent-session-bus: (codex|pi|claude|opencode):([^\r\n<>]{1,256}) -->[ \t]*(?:\r?\n|$)/gm)];
  const allOpenings = [...original.matchAll(/^<!-- agent-session-bus:.*-->[ \t]*\r?$/gm)];
  if (allOpenings.length !== openings.length) throw new Error(`invalid agent-session-bus marker in ${file}`);
  const closings = [...original.matchAll(/^<!-- \/agent-session-bus -->[ \t]*(?=\r?$)/gm)];
  if (closings.some((m) => !openings.length || m.index < openings[0].index)) {
    throw new Error(`orphan closing agent-session-bus marker in ${file}; review the file before repair`);
  }
  const blocks = [];
  let recoveredBlocks = 0;
  for (let i = 0; i < openings.length; i++) {
    const start = openings[i];
    const nextStart = openings[i + 1]?.index ?? original.length;
    const candidates = closings.filter((m) => m.index >= start.index + start[0].length && m.index < nextStart);
    const recovered = candidates.length !== 1;
    if (recovered && !opts.recover) {
      throw new Error(`unterminated or ambiguous closing agent-session-bus block in ${file}; use repair-context --recover after reviewing a backup`);
    }
    if (recovered) recoveredBlocks++;
    // Explicit recovery includes everything up to the last closing marker, not
    // just the first fragment of a transcript containing an embedded marker.
    const endMarker = candidates.at(-1);
    const end = endMarker ? endMarker.index + endMarker[0].length : nextStart;
    blocks.push({ index: start.index, end, recovered, key: sessionKey(start[1], start[2]), raw: original.slice(start.index, end), body: original.slice(start.index + start[0].length, endMarker ? endMarker.index : end) });
  }
  const latest = new Map();
  let migrated = 0;
  for (const b of blocks) {
    const isReference = !b.recovered && (b.body.startsWith(REFERENCE_TAG + '\n') || b.body.startsWith(REFERENCE_TAG + '\r\n'));
    const block = isReference ? b.raw : archive(b.key, b.raw).block;
    if (!isReference) migrated++;
    latest.set(b.key, { index: b.index, block });
  }
  let transcriptFile = null;
  if (incoming) {
    const entry = archive(incoming.key, incoming.content);
    transcriptFile = entry.abs;
    const existing = latest.get(incoming.key);
    latest.set(incoming.key, { index: existing ? existing.index : null, block: entry.block });
  }
  let content = '';
  let offset = 0;
  for (const b of blocks) {
    content += original.slice(offset, b.index);
    const entry = latest.get(b.key);
    if (entry.index === b.index) content += entry.block;
    // Unclosed records consume up to the next opening marker; keep the new
    // reference on its own line so a future strict import can parse it.
    if (b.raw.endsWith('\n') && entry.index === b.index) content += '\n';
    offset = b.end;
  }
  content += original.slice(offset);
  if (incoming && latest.get(incoming.key).index === null) {
    content += (content ? (content.endsWith('\n') ? '\n' : '\n\n') : '') + latest.get(incoming.key).block + '\n';
  }
  return { file, cwd, existed, original, content, archives, transcriptFile, migrated, recoveredBlocks, duplicatesRemoved: blocks.length - new Set(blocks.map((b) => b.key)).size };
}

function applyContext(plan, opts) {
  const changed = plan.content !== plan.original;
  let backup = null;
  if (!opts.dryRun) {
    // Check before writing archives or the context in case another process edited it.
    const current = fs.existsSync(plan.file) ? fs.readFileSync(plan.file, 'utf8') : '';
    if (current !== plan.original) throw new Error(`context changed during import: ${plan.file}; retry`);
    for (const [file, content] of plan.archives) {
      U.ensureDir(path.dirname(file));
      try { fs.writeFileSync(file, content, { flag: 'wx' }); }
      catch (e) {
        if (e.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== content) throw e;
      }
    }
    if (changed) {
      U.ensureDir(path.dirname(plan.file));
      if (plan.existed) {
        backup = path.join(plan.cwd, '.agent-session-bus', 'backups', `${path.basename(plan.file)}.${U.piFileStamp(U.nowIso())}.${U.hexId()}.bak`);
        U.ensureDir(path.dirname(backup));
        fs.copyFileSync(plan.file, backup, fs.constants.COPYFILE_EXCL);
      }
      const tmp = path.join(plan.cwd, `.${path.basename(plan.file)}.${U.hexId()}.tmp`);
      try {
        fs.writeFileSync(tmp, plan.content, { flag: 'wx' });
        fs.renameSync(tmp, plan.file);
      } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    }
  }
  return {
    file: plan.file, bytes: Buffer.byteLength(plan.content), contextCharacters: plan.content.length,
    wrote: !opts.dryRun && changed, backup, transcriptFile: plan.transcriptFile,
    archivedFiles: [...plan.archives.keys()], migrated: plan.migrated, recoveredBlocks: plan.recoveredBlocks, duplicatesRemoved: plan.duplicatesRemoved,
  };
}

function injectContext(to, ir, opts = {}) {
  const key = sessionKey(ir.agent, ir.session_id);
  const plan = planContext(to, opts, { key, content: render.toMarkdown(ir, { full: true }) });
  return { action: 'context', target: to, ...applyContext(plan, opts), note: 'full transcript archived; only a short reference is loaded as context (restart the target or reload context files)' };
}

function repairContext(opts = {}) {
  const to = opts.to || 'pi';
  return { action: 'repair-context', target: to, ...applyContext(planContext(to, opts), opts) };
}

function contextFileFromDir(dir) {
  for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) { fs.readFileSync(file, 'utf8'); return file; }
    } catch { /* Pi also skips unreadable files and non-files. */ }
  }
  return null;
}

function realPath(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

function shadowedWorktreeContext(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const gitPath = path.join(dir, '.git');
    if (fs.existsSync(gitPath)) {
      try {
        if (fs.statSync(gitPath).isDirectory()) return null; // ordinary repo
        const text = fs.readFileSync(gitPath, 'utf8').trim();
        if (text.startsWith('gitdir: ')) {
          const gitDir = path.resolve(dir, text.slice(8).trim());
          if (!fs.existsSync(path.join(gitDir, 'HEAD'))) return null;
          const commonFile = path.join(gitDir, 'commondir');
          const common = realPath(fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir);
          const worktree = realPath(dir);
          const main = path.dirname(common);
          if (!worktree.startsWith(main + path.sep) || realPath(path.join(main, '.git')) !== common) return null;
          const ownContext = contextFileFromDir(worktree);
          return ownContext ? path.join(main, path.basename(ownContext)) : null;
        }
      } catch { return null; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Pi loads project instructions from its agent directory and every cwd ancestor,
// with AGENTS.override.md taking precedence over AGENTS.md and CLAUDE.md.
// Native injection must check this seam too, not only --mode context.
function preparePiContext(cwd, opts = {}) {
  const ancestors = [];
  let current = path.resolve(cwd || process.cwd());
  for (;;) {
    ancestors.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const dirs = [path.resolve(U.roots().pi), ...ancestors];
  const shadowed = shadowedWorktreeContext(cwd || process.cwd());
  const seen = new Set();
  const plans = [];
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const file = contextFileFromDir(dir);
    if (!file || seen.has(file)) continue;
    if (i > 0 && shadowed && realPath(file) === shadowed) continue;
    seen.add(file);
    plans.push(planContext('pi', { cwd: dir, contextName: path.basename(file) }));
  }
  const characters = plans.reduce((sum, p) => sum + p.content.length, 0);
  // Leave room for Pi's own instructions, skill descriptors and extensions.
  // Non-imported project rules are never trimmed automatically.
  if (characters > 800000) {
    throw new Error(`Pi project instructions/context files remain too large (${characters} characters): ${plans.filter((p) => p.content.length).map((p) => p.file).join(', ')}. Move historical content out of instructions before native injection; no session was written.`);
  }
  const repairs = plans.filter((p) => p.content !== p.original).map((p) => applyContext(p, opts));
  return { characters, repairs };
}

module.exports = { injectContext, repairContext, preparePiContext };
