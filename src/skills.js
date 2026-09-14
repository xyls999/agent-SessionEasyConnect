'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');

// Where each agent discovers skills. All four read the same SKILL.md (frontmatter
// name + description), so a skill directory is portable as-is.
const AGENTS = ['opencode', 'claude', 'codex', 'pi'];

function skillRoots() {
  const home = U.HOME;
  const opencodeCfg = process.env.OPENCODE_CONFIG_DIR || path.join(home, '.config', 'opencode');
  const claudeCfg = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return {
    opencode: path.join(opencodeCfg, 'skills'),
    claude: path.join(claudeCfg, 'skills'),
    codex: path.join(U.roots().codex, 'skills'),
    pi: path.join(U.roots().pi, 'skills'),
    agents: path.join(home, '.agents', 'skills'),
  };
}

function readSkillMeta(dir) {
  const md = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(md)) return null;
  let name = path.basename(dir);
  let description = '';
  try {
    const txt = fs.readFileSync(md, 'utf8');
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      for (const line of m[1].split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (k === 'name' && v) name = v;
        if (k === 'description') description = v;
      }
    }
  } catch { /* keep defaults */ }
  return { name, description };
}

function listSkills() {
  const roots = skillRoots();
  const map = new Map();
  for (const agent of AGENTS) {
    const root = roots[agent];
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      const meta = readSkillMeta(dir);
      if (!meta) continue;
      if (!map.has(meta.name)) map.set(meta.name, { name: meta.name, description: meta.description, agents: {}, dirs: {} });
      const rec = map.get(meta.name);
      rec.agents[agent] = true;
      rec.dirs[agent] = dir;
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function resolveTargets(spec) {
  if (!spec || spec === 'all') return AGENTS.slice();
  const out = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of out) if (!AGENTS.includes(a)) throw new Error(`unknown target agent: ${a} (use opencode,claude,codex,pi or all)`);
  return out;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// Install one skill dir, or every skill dir under a container folder.
function installSkill(srcDir, opts = {}) {
  const roots = skillRoots();
  const targets = resolveTargets(opts.agent);
  const srcAbs = path.resolve(srcDir);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const items = [];
  if (fs.existsSync(path.join(srcAbs, 'SKILL.md'))) {
    const meta = readSkillMeta(srcAbs) || { name: path.basename(srcAbs) };
    items.push({ name: opts.name || meta.name, dir: srcAbs });
  } else {
    for (const e of fs.readdirSync(srcAbs, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(srcAbs, e.name);
      if (!fs.existsSync(path.join(d, 'SKILL.md'))) continue;
      const meta = readSkillMeta(d) || { name: e.name };
      items.push({ name: meta.name, dir: d });
    }
  }
  if (!items.length) throw new Error(`no SKILL.md found under ${srcAbs}`);

  const results = [];
  for (const it of items) {
    for (const agent of targets) {
      const dest = path.join(roots[agent], it.name);
      if (fs.existsSync(dest)) {
        if (!opts.force) { results.push({ skill: it.name, agent, dest, status: 'exists (use --force)' }); continue; }
        fs.rmSync(dest, { recursive: true, force: true });
      }
      U.ensureDir(path.dirname(dest));
      copyDir(it.dir, dest);
      results.push({ skill: it.name, agent, dest, status: 'installed' });
    }
  }
  return results;
}

// Copy an already-installed skill from one agent to the others.
function syncSkill(name, opts = {}) {
  const all = listSkills();
  const rec = all.find((r) => r.name === name || r.name.toLowerCase() === String(name).toLowerCase());
  if (!rec) throw new Error(`skill not found in any agent dir: ${name}`);
  const from = opts.from || Object.keys(rec.dirs)[0];
  if (!rec.dirs[from]) throw new Error(`skill "${name}" is not present for agent "${from}" (present: ${Object.keys(rec.dirs).join(', ')})`);
  const targets = resolveTargets(opts.to).filter((a) => a !== from);
  return installSkill(rec.dirs[from], { name: rec.name, agent: targets.join(','), force: opts.force });
}

module.exports = { skillRoots, listSkills, installSkill, syncSkill, AGENTS };
