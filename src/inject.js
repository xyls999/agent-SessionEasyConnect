'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const render = require('./render');
const { injectContext, preparePiContext } = require('./context');

const STORE = {
  codex: () => U.roots().codex,
  pi: () => U.roots().pi,
  claude: () => U.roots().claude,
};

function injectNative(to, ir, opts) {
  if (to === 'opencode') {
    const gen = render.genOpenCodeImport(ir);
    const out = opts.out || path.join(process.cwd(), gen.file);
    if (!opts.dryRun) { U.ensureDir(path.dirname(out)); fs.writeFileSync(out, gen.content); }
    const cwd = ir.cwd || process.cwd();
    return {
      action: 'native', target: 'opencode', file: out, sid: gen.sid, wrote: !opts.dryRun,
      hint: `opencode import "${out}"`,
      note: `run that from the session directory (${cwd}) — opencode files the session under the directory you run import from`,
    };
  }
  let piModel = {};
  if (to === 'pi') {
    const settingsFile = path.join(STORE.pi(), 'settings.json');
    const settings = fs.existsSync(settingsFile) ? U.safeJson(fs.readFileSync(settingsFile, 'utf8')) : null;
    piModel = { provider: settings && settings.defaultProvider, model: settings && settings.defaultModel };
  }
  const gen = to === 'codex' ? render.genCodex(ir) : to === 'pi' ? render.genPi(ir, piModel) : render.genClaude(ir);
  const abs = path.join(STORE[to](), gen.relPath);
  const context = to === 'pi' ? preparePiContext(ir.cwd || process.cwd(), opts) : null;
  if (!opts.dryRun) { U.ensureDir(path.dirname(abs)); fs.writeFileSync(abs, gen.content); }
  let register = null;
  if (to === 'codex' && !opts.dryRun && opts.register !== false) {
    try { register = require('./codex-register').registerCodex(gen.sid, abs, ir); }
    catch (e) { register = { ok: false, reason: String(e.message || e) }; }
  }
  const resume = to === 'codex' ? `codex resume ${gen.sid}` : to === 'pi' ? `pi --session ${gen.sid}` : `claude --resume ${gen.sid}`;
  return {
    action: 'native', target: to, file: abs, sid: gen.sid, bytes: Buffer.byteLength(gen.content), hint: resume, wrote: !opts.dryRun, register,
    ...(context ? { contextRepairs: context.repairs, loadedContextCharacters: context.characters, activeCharacters: gen.activeCharacters, checkpoints: gen.checkpoints } : {}),
  };
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
