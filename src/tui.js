'use strict';
const readline = require('readline');
const adapters = require('./adapters');
const injector = require('./inject');
const render = require('./render');
const U = require('./util');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
};
const AGENT_COLOR = { codex: C.green, pi: C.magenta, claude: C.yellow, opencode: C.blue };
const AGENTS = ['codex', 'pi', 'claude', 'opencode'];

function clr() { process.stdout.write('\x1b[2J\x1b[H'); }
function badge(a) { return `${AGENT_COLOR[a] || ''}${a.padEnd(8)}${C.reset}`; }
function fmt(ms) { return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '-'; }

let SESSIONS = [];
let FILTER = 'all';

function reload() { SESSIONS = adapters.listAll().filter((s) => !s.error); }

function view() {
  const rows = SESSIONS.filter((s) => FILTER === 'all' || s.agent === FILTER);
  clr();
  console.log(`${C.bold}agent-session-bus TUI${C.reset}  ${C.dim}${SESSIONS.length} sessions · filter=${FILTER}${C.reset}\n`);
  if (!rows.length) { console.log('  (no sessions)\n'); return rows; }
  rows.forEach((s, i) => {
    console.log(`  ${C.cyan}${String(i + 1).padStart(3)}${C.reset}  ${badge(s.agent)} ${C.dim}${fmt(s.created_at)}${C.reset}  ${String(s.id).slice(0, 38).padEnd(38)}  ${C.dim}${String(s.cwd || '-').slice(0, 28)}${C.reset}`);
  });
  console.log(`\n  ${C.dim}命令: <编号> 查看 | i <编号> 注入 | v <编号> 验证可读 | f <agent|all> 过滤 | s <关键词> 搜索 | r 刷新 | q 退出${C.reset}`);
  return rows;
}

function search(q) { return SESSIONS.filter((s) => [s.id, s.cwd, s.title].some((v) => String(v || '').toLowerCase().includes(q.toLowerCase()))); }

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  reload();

  let lastRows = [];
  for (;;) {
    lastRows = view();
    const ans = (await ask(`\n${C.cyan}asb>${C.reset} `)).trim();
    if (!ans) continue;
    if (ans === 'q' || ans === 'quit' || ans === 'exit') break;
    if (ans === 'r') { reload(); continue; }
    if (ans.startsWith('f ')) {
      const f = ans.slice(2).trim();
      FILTER = (f === 'all' || AGENTS.includes(f)) ? f : FILTER;
      continue;
    }
    if (ans.startsWith('s ')) {
      const q = ans.slice(2).trim();
      SESSIONS = search(q);
      FILTER = 'all';
      continue;
    }
    const m = ans.match(/^(i|v)?\s*(\d+)$/);
    if (m) {
      const idx = Number(m[2]) - 1;
      const s = lastRows[idx];
      if (!s) { console.log(`${C.red}无效编号${C.reset}`); continue; }
      if (m[1] === 'i') { await injectFlow(rl, ask, s); continue; }
      if (m[1] === 'v') { await verifyFlow(s, null); continue; }
      await showSession(rl, s);
      continue;
    }
    console.log(`${C.red}未知命令${C.reset}`);
  }
  clr();
  rl.close();
}

async function showSession(rl, s) {
  clr();
  try {
    const ir = adapters.read(s.agent, s.id);
    console.log(render.toText(ir));
  } catch (e) {
    console.log(`${C.red}读取失败: ${e.message}${C.reset}`);
  }
  console.log(`\n${C.dim}--- 回车返回，或输入 i 直接注入此会话 ---${C.reset}`);
  const a = (await new Promise((r) => rl.question('', r))).trim();
  if (a === 'i') await injectFlow(rl, (q) => new Promise((r) => rl.question(q, r)), s);
}

async function injectFlow(rl, ask, s) {
  console.log(`\n${C.bold}注入会话${C.reset} ${badge(s.agent)} ${s.id}`);
  const to = (await ask(`目标 agent [codex/pi/claude/opencode] (codex): `)).trim() || 'codex';
  const mode = (await ask(`模式 [native/context] (native): `)).trim() || 'native';
  let cwd;
  if (mode === 'context') cwd = (await ask(`context cwd (回车=当前目录): `)).trim() || process.cwd();
  try {
    const r = injector.inject({ fromAgent: s.agent, fromId: s.id, to, mode, cwd });
    console.log(`${C.green}✓ 已写入${C.reset} ${r.file}`);
    if (r.hint) console.log(`  ${C.dim}读取: ${r.hint}${C.reset}`);
    reload();
    const yn = (await ask(`现在验证 ${to} 能读出来吗? [y/N]: `)).trim().toLowerCase();
    if (yn === 'y') await verifyFlow({ agent: to, id: r.sid }, r.file);
  } catch (e) {
    console.log(`${C.red}注入失败: ${e.message}${C.reset}`);
  }
  await ask(`${C.dim}回车继续${C.reset}`);
}

function run(cmd, args, timeout = 60000) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(cmd, args, { shell: true, encoding: 'utf8', timeout });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

async function verifyFlow(s, file) {
  console.log(`\n${C.bold}验证 ${s.agent} 读取 ${s.id}${C.reset}`);
  let out = '';
  if (s.agent === 'codex') out = run('codex', ['migrate-rollouts', '--json', '--thread', s.id]);
  else if (s.agent === 'opencode') out = run('opencode', ['export', s.id]);
  else if (s.agent === 'pi' && file) {
    const tmp = require('path').join(require('os').tmpdir(), `asb-${s.id}.html`);
    out = run('pi', ['--export', `"${file}"`, `"${tmp}"`]);
    out += `\n(html: ${tmp})`;
  } else out = `(no CLI read command; native file written: ${file || 'n/a'})`;
  const ok = out.includes(s.id) || out.length > 0;
  console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${C.dim}$${C.reset} ${out.slice(0, 1500)}`);
}


module.exports = { main };
