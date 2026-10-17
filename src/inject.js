'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./util');
const render = require('./render');
const { injectContext, preparePiContext } = require('./context');

const STORE = {
  codex: () => U.roots().codex,
  pi: () => U.roots().pi,
  claude: () => U.roots().claude,
};

// Run `opencode import <file>` from the session's own directory: opencode files the
// session under the import cwd and only reports success as "Imported session: ses_...",
// so generating the JSON alone left users with a file that never became readable.
function importViaOpenCodeCli(outFile, dir, runner) {
  if (runner) return runner(outFile, dir);
  const { spawnSync } = require('child_process');
  let r;
  try {
    U.ensureDir(dir);
    r = spawnSync(`opencode import "${outFile}"`, { shell: true, encoding: 'utf8', cwd: dir, timeout: 600000, windowsHide: true });
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
  const output = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.error) return { ok: false, reason: String((r.error && r.error.message) || r.error), output: output.slice(0, 2000) };
  if (r.status !== 0) return { ok: false, reason: output || `opencode import exited with status ${r.status}`, output: output.slice(0, 2000) };
  if (!/Imported session/i.test(output)) return { ok: false, reason: output || 'opencode import did not confirm the session', output: output.slice(0, 2000) };
  const m = output.match(/Imported session:\s*(\S+)/i);
  return { ok: true, sid: m ? m[1] : undefined, output: output.slice(0, 2000) };
}

// opencode continues a session with the model stored on the session itself. Source
// providers (pi/codex/claude) are unknown/unregistered inside opencode, so an import
// pinned to them (or to the phantom 'imported' provider) fails the first reply with
// "model not found"/Bad Request. Borrow the most recent real model the local store has
// actually used; --model provider/id overrides, targetModel:false opts out (tests).
function resolveOpenCodeTargetModel(opts) {
  if (opts.targetModel !== undefined) return opts.targetModel;
  if (opts.model) {
    const s = String(opts.model);
    const i = s.lastIndexOf('/');
    if (i <= 0 || i === s.length - 1) throw new Error(`--model must be provider/model, got: ${s}`);
    return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
  }
  try {
    const dbPath = path.join(U.roots().opencode, 'opencode.db');
    if (!fs.existsSync(dbPath)) return undefined;
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const r of db.prepare('SELECT model FROM session WHERE model IS NOT NULL ORDER BY time_updated DESC LIMIT 12').all()) {
        let m; try { m = JSON.parse(r.model); } catch { continue; }
        if (m && m.providerID && m.providerID !== 'imported' && m.id) return { providerID: m.providerID, modelID: m.id };
      }
    } finally { db.close(); }
  } catch { /* db locked/unavailable: fall back to legacy 'imported' metadata */ }
  return undefined;
}

function injectNative(to, ir, opts) {
  if (to === 'opencode') {
    const target = resolveOpenCodeTargetModel(opts);
    const gen = render.genOpenCodeImport(ir, target);
    const cwd = String(ir.cwd || process.cwd()).replace(/^\\\\\?\\/, '');
    const tempOut = !opts.out;
    const out = tempOut ? path.join(os.tmpdir(), gen.file) : path.resolve(String(opts.out));
    const res = { action: 'native', target: 'opencode', file: out, sid: gen.sid, wrote: !opts.dryRun };
    if (opts.dryRun) {
      res.hint = `opencode import "${out}"`;
      res.note = `dry-run: nothing written; the real import runs \`opencode import\` automatically from ${cwd}`;
      return res;
    }
    U.ensureDir(path.dirname(out));
    fs.writeFileSync(out, gen.content);
    if (opts.noImport) {
      res.hint = `opencode import "${out}"`;
      res.note = `--no-import: JSON only. Run that from the session directory (${cwd}) — opencode files the session under the directory you run import from`;
      return res;
    }
    const imp = importViaOpenCodeCli(out, cwd, opts.runImport);
    res.imported = imp.ok;
    if (imp.sid) res.sid = imp.sid;
    if (imp.ok) {
      let removed = false;
      if (tempOut && !opts.keepFile) {
        try { fs.rmSync(out, { force: true }); removed = true; } catch { /* keep hint about the file if deletion fails */ }
      }
      res.hint = `opencode (open it from the session directory: ${cwd})`;
      const bound = target ? `; continue-chat model bound: ${target.providerID}/${target.modelID}` : '; no usable local model found - pick one in opencode before continuing';
      res.note = (removed
        ? `imported into opencode.db (project ${cwd}); temp import JSON auto-removed (use --out/--keep-file to keep it)`
        : `imported into opencode.db (project ${cwd}); import JSON kept at ${out}`) + bound;
    } else {
      res.hint = `opencode import "${out}"`;
      res.note = `auto-import FAILED: ${imp.reason} — JSON kept at ${out}; run the hint from the session directory (${cwd}), or pass --no-import to skip auto-import`;
    }
    return res;
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

module.exports = { inject, injectNative, importViaOpenCodeCli };
