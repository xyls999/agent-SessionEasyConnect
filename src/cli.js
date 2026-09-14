#!/usr/bin/env node
'use strict';
const path = require('path');
const adapters = require('./adapters');
const injector = require('./inject');
const render = require('./render');
const U = require('./util');

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function fmtRow(s) {
  const t = s.created_at ? U.msToIso(s.created_at).replace('T', ' ').slice(0, 19) : '-';
  const id = s.id || (s.error ? '(error)' : '?');
  return [
    s.agent.padEnd(9),
    String(id).slice(0, 40).padEnd(40),
    t.padEnd(19),
    String(s.cwd || '-').slice(0, 32).padEnd(32),
    s.title ? String(s.title).slice(0, 30) : '',
  ].join('  ');
}

function cmdList(o) {
  const rows = adapters.listAll(o.agent);
  if (o.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log('(no sessions found)'); return; }
  console.log('AGENT      SESSION_ID'.padEnd(51) + '  CREATED              CWD'.padEnd(53) + '  TITLE');
  for (const r of rows) console.log(fmtRow(r));
  const counts = {};
  for (const r of rows) counts[r.agent] = (counts[r.agent] || 0) + 1;
  console.error(`\n${rows.length} session(s): ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', '));
}

function cmdShow(o) {
  const [, agent, id] = o._;
  if (!agent || !id) throw new Error('usage: asb show <agent> <sessionId> [--format canonical|text|markdown]');
  const ir = adapters.read(agent, id);
  const format = o.format || 'text';
  if (format === 'canonical' || format === 'json') console.log(JSON.stringify(ir, null, 2));
  else if (format === 'markdown' || format === 'md') console.log(render.toMarkdown(ir));
  else console.log(render.toText(ir));
}

function cmdRoots() {
  console.log(JSON.stringify(U.roots(), null, 2));
}

function cmdInject(o) {
  let fromAgent = o.from, fromId = o.id;
  if (fromAgent && fromAgent.includes(':')) { const [a, b] = fromAgent.split(':'); fromAgent = a; fromId = b; }
  const res = injector.inject({
    fromAgent, fromId, to: o.to, mode: o.mode, out: o.out, cwd: o.cwd, dryRun: !!o['dry-run'],
    register: !o['no-register'],
  });
  console.log(JSON.stringify(res, null, 2));
  if (res.wrote && res.action === 'native') console.error(`\nWrote native ${res.target} session. Open it with:\n  ${res.hint}`);
  if (res.wrote && res.action === 'context') console.error(`\nAppended transcript to ${res.file}. Start ${res.target} in that cwd and it will read it.`);
}

function cmdSkills(o) {
  const skills = require('./skills');
  const sub = o._[1];
  if (sub === 'roots') { console.log(JSON.stringify(skills.skillRoots(), null, 2)); return; }
  if (!sub || sub === 'list') {
    const rows = skills.listSkills();
    if (o.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log('(no skills found)'); return; }
    const agents = skills.AGENTS;
    console.log('SKILL'.padEnd(30) + agents.map((a) => a.padEnd(11)).join(''));
    for (const r of rows) {
      console.log(String(r.name).slice(0, 28).padEnd(30) + agents.map((a) => (r.agents[a] ? '  yes      ' : '  .        ')).join(''));
    }
    const multi = rows.filter((r) => Object.keys(r.agents).length > 1).length;
    console.error(`\n${rows.length} skill(s); ${multi} present in >1 agent. Install/sync with: asec skills install <dir> --to all`);
    return;
  }
  if (sub === 'install') {
    const src = o._[2];
    if (!src) throw new Error('usage: asec skills install <path-to-skill-or-folder> [--to all|codex,claude,opencode,pi] [--name NAME] [--force]');
    console.log(JSON.stringify(skills.installSkill(src, { agent: o.to, name: o.name, force: !!o.force }), null, 2));
    return;
  }
  if (sub === 'sync') {
    const name = o._[2];
    if (!name) throw new Error('usage: asec skills sync <skill-name> [--from agent] [--to all|csv] [--force]');
    console.log(JSON.stringify(skills.syncSkill(name, { from: o.from, to: o.to, force: !!o.force }), null, 2));
    return;
  }
  throw new Error(`unknown skills subcommand: ${sub} (use: list | roots | install | sync)`);
}

function help() {
  console.log(`Agent Session Easy Connect (asec) - session + skill interchange for coding agents

Usage:
  asec list [--agent codex|pi|claude|opencode] [--json]
  asec show <agent> <sessionId> [--format text|markdown|canonical]
  asec roots
  asec inject --from <agent>:<sessionId> --to <agent> [--mode native|context] [--out FILE] [--cwd DIR] [--dry-run] [--no-register]
  asec skills list [--json]
  asec skills roots
  asec skills install <path-to-skill-or-folder> [--to all|codex,pi,claude,opencode] [--name NAME] [--force]
  asec skills sync <skill-name> [--from <agent>] [--to all|csv] [--force]
  asec tui
  asec web [--port 8787]

Examples:
  asec skills list
  asec skills sync brainstorming --to all
  asec inject --from opencode:ses_xxxx --to codex --mode native
  asec tui
  asec web --port 8787
  asec show opencode ses_xxxx --format markdown
  asec inject --from claude:11111111-2222-3333-4444-555555555555 --to codex --mode native
  asec inject --from codex:01a09985-2328-7831-8a61-fee95d251a89 --to claude --mode native
  asec inject --from opencode:ses_xxxx --to pi --mode context --cwd E:\myproject

Agents:
  codex     ~/.codex/sessions/**/rollout-*.jsonl            (JSONL)
  pi        ~/.pi/agent/sessions/<cwd>/<ts>_<uuid>.jsonl    (JSONL)
  claude    ~/.claude/projects/<cwd>/<uuid>.jsonl           (JSONL)
  opencode  ~/.local/share/opencode/opencode.db             (SQLite)
`);
}

function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  try {
    if (!cmd || cmd === 'help' || o.help) return help();
    if (cmd === 'list' || cmd === 'ls') return cmdList(o);
    if (cmd === 'show' || cmd === 'read') return cmdShow(o);
    if (cmd === 'roots') return cmdRoots();
    if (cmd === 'skills' || cmd === 'skill') return cmdSkills(o);
    if (cmd === 'web' || cmd === 'serve') { require('./server').start(Number(o.port) || 8787); return; }
    if (cmd === 'tui' || cmd === 'ui') { require('./tui').main(); return; }
    if (cmd === 'inject') return cmdInject(o);
    throw new Error(`unknown command: ${cmd}`);
  } catch (e) {
    console.error('error: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

main();
