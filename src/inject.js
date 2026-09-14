'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const render = require('./render');

const STORE = {
  codex: () => U.roots().codex,
  pi: () => U.roots().pi,
  claude: () => U.roots().claude,
};

const CONTEXT_FILE = { codex: 'AGENTS.md', pi: 'AGENTS.md', claude: 'CLAUDE.md', opencode: 'AGENTS.md' };

function injectNative(to, ir, opts) {
  if (to === 'opencode') {
    const gen = render.genOpenCodeImport(ir);
    const out = opts.out || path.join(process.cwd(), gen.file);
    if (!opts.dryRun) { U.ensureDir(path.dirname(out)); fs.writeFileSync(out, gen.content); }
    return { action: 'native', target: 'opencode', file: out, sid: gen.sid, hint: `opencode import "${out}"`, wrote: !opts.dryRun };
  }
  const gen = to === 'codex' ? render.genCodex(ir) : to === 'pi' ? render.genPi(ir) : render.genClaude(ir);
  const abs = path.join(STORE[to](), gen.relPath);
  if (!opts.dryRun) { U.ensureDir(path.dirname(abs)); fs.writeFileSync(abs, gen.content); }
  let register = null;
  if (to === 'codex' && !opts.dryRun && opts.register !== false) {
    try { register = require('./codex-register').registerCodex(gen.sid, abs, ir); }
    catch (e) { register = { ok: false, reason: String(e.message || e) }; }
  }
  const resume = to === 'codex' ? `codex resume ${gen.sid}` : to === 'pi' ? `pi --session ${gen.sid}` : `claude --resume ${gen.sid}`;
  return { action: 'native', target: to, file: abs, sid: gen.sid, bytes: gen.content.length, hint: resume, wrote: !opts.dryRun, register };
}

function injectContext(to, ir, opts) {
  const cwd = opts.cwd || process.cwd();
  const file = path.join(cwd, CONTEXT_FILE[to] || 'AGENTS.md');
  const md = render.toMarkdown(ir);
  const marker = `<!-- agent-session-bus: ${ir.agent}:${ir.session_id} -->`;
  const block = `\n\n${marker}\n## Imported session from ${ir.agent} (${ir.session_id})\n\n${md}\n<!-- /agent-session-bus -->\n`;
  if (!opts.dryRun) {
    U.ensureDir(path.dirname(file));
    fs.appendFileSync(file, block);
  }
  return { action: 'context', target: to, file, bytes: block.length, wrote: !opts.dryRun, note: `appended imported transcript to ${path.basename(file)}` };
}

function inject(opts) {
  const { fromAgent, fromId, to } = opts;
  if (!fromAgent || !fromId) throw new Error('inject requires --from <agent>:<id>');
  if (!to) throw new Error('inject requires --to <agent>');
  if (!['codex', 'pi', 'claude', 'opencode'].includes(to)) throw new Error(`unknown target agent: ${to}`);
  const adapters = require('./adapters');
  const ir = adapters.read(fromAgent, fromId);
  const mode = opts.mode || 'native';
  if (mode === 'context') return injectContext(to, ir, opts);
  return injectNative(to, ir, opts);
}

module.exports = { inject };
