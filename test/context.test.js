'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { inject } = require('../src/inject');

function fixture(t, text = 'historical text') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-context-'));
  const home = path.join(dir, 'pi');
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.mkdirSync(cwd);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  const source = path.join(home, 'sessions', 'source.jsonl');
  function save(value) {
    fs.writeFileSync(source, [
      { type: 'session', version: 3, id: 'source', cwd },
      { type: 'message', id: '12345678', parentId: null, message: { role: 'user', content: [{ type: 'text', text: value }], timestamp: 1789368195269 } },
    ].map(JSON.stringify).join('\n'));
  }
  save(text);
  return { cwd, save, file: path.join(cwd, 'AGENTS.md'), opts: { fromAgent: 'pi', fromId: 'source', to: 'pi', mode: 'context', cwd } };
}
function legacy(key, text) {
  return `<!-- agent-session-bus: ${key} -->\n## Imported session\n\n${text}\n<!-- /agent-session-bus -->`;
}

test('large imported transcripts are archived, not injected into system instructions', (t) => {
  const f = fixture(t, '大'.repeat(1200000));
  fs.writeFileSync(f.file, '# Project rules\nRun npm test.\n');
  const result = inject(f.opts);
  const context = fs.readFileSync(f.file, 'utf8');
  assert.ok(context.length < 4096, `system context grew to ${context.length} characters`);
  assert.match(context, /Run npm test/);
  assert.ok(result.transcriptFile && fs.existsSync(result.transcriptFile));
  assert.ok(fs.readFileSync(result.transcriptFile, 'utf8').includes('大'.repeat(1200000)));
  assert.ok(context.includes(path.relative(f.cwd, result.transcriptFile).replace(/\\/g, '/')));
});

test('reimporting the same session does not grow the context file', (t) => {
  const f = fixture(t);
  inject(f.opts);
  const first = fs.readFileSync(f.file, 'utf8');
  inject(f.opts);
  assert.equal(fs.readFileSync(f.file, 'utf8'), first);
  f.save('new history');
  const result = inject(f.opts);
  const latest = fs.readFileSync(f.file, 'utf8');
  assert.equal((latest.match(/<!-- agent-session-bus:/g) || []).length, 1);
  assert.match(fs.readFileSync(result.transcriptFile, 'utf8'), /new history/);
});

test('injecting into a legacy context migrates and deduplicates old blocks with exact backup', (t) => {
  const f = fixture(t);
  const old = '# Real instructions\r\nDo not delete these.\r\n\r\n' + legacy('opencode:ses_old', 'old payload') + '\n\nBetween blocks\n' + legacy('opencode:ses_old', 'different snapshot') + '\nTrailing instructions\n';
  fs.writeFileSync(f.file, old);
  const result = inject(f.opts);
  const context = fs.readFileSync(f.file, 'utf8');
  assert.ok(result.backup && fs.existsSync(result.backup));
  assert.equal(fs.readFileSync(result.backup, 'utf8'), old);
  assert.ok(context.startsWith('# Real instructions\r\nDo not delete these.\r\n'));
  assert.match(context, /Between blocks/);
  assert.match(context, /Trailing instructions/);
  assert.equal((context.match(/<!-- agent-session-bus: opencode:ses_old -->/g) || []).length, 1);
  assert.ok(!context.includes('different snapshot'));
  const archived = result.archivedFiles.map((file) => fs.readFileSync(file, 'utf8'));
  assert.ok(archived.some((text) => text.includes('old payload')));
  assert.ok(archived.some((text) => text.includes('different snapshot')));
});

test('native Pi injection selects the configured target model, not the foreign source', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'target-model' }));
  fs.appendFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', 'source.jsonl'), '\n' + JSON.stringify({ type: 'message', id: '87654321', parentId: '12345678', message: { role: 'assistant', model: 'foreign-model', content: [{ type: 'text', text: 'historical reply' }] } }));
  const result = inject({ ...f.opts, mode: 'native' });
  const rows = fs.readFileSync(result.file, 'utf8').trim().split('\n').map(JSON.parse);
  // Pi infers model metadata from every assistant too; the last model-bearing
  // entry must be the target selection, not the source assistant metadata.
  const model = rows.filter((r) => r.type === 'model_change' || r.message?.role === 'assistant').at(-1);
  assert.ok(model, 'configured target model selection was lost');
  assert.equal(model.type, 'model_change');
  assert.equal(model.provider, 'openai-codex');
  assert.equal(model.modelId, 'target-model');
});

test('native Pi injection repairs legacy project instructions in the resumed cwd', (t) => {
  const f = fixture(t);
  const old = '# Keep project rules\n' + legacy('codex:old', 'L'.repeat(2239848));
  fs.writeFileSync(f.file, old);
  const result = inject({ ...f.opts, mode: 'native' });
  assert.ok(fs.readFileSync(f.file, 'utf8').length < 4096);
  assert.ok(fs.readFileSync(f.file, 'utf8').startsWith('# Keep project rules\n'));
  assert.ok(result.contextRepairs.some((r) => r.file === f.file && r.backup));
  const repaired = result.contextRepairs.find((r) => r.file === f.file);
  assert.equal(fs.readFileSync(repaired.backup, 'utf8'), old);
});

test('native dry-run previews project context repair without modifying it', (t) => {
  const f = fixture(t);
  const old = legacy('pi:old', 'L'.repeat(2239848));
  fs.writeFileSync(f.file, old);
  const result = inject({ ...f.opts, mode: 'native', dryRun: true });
  assert.equal(fs.readFileSync(f.file, 'utf8'), old);
  assert.equal(fs.existsSync(result.file), false);
  assert.ok(result.contextRepairs.some((r) => r.file === f.file && r.migrated === 1));
  assert.equal(fs.existsSync(path.join(f.cwd, '.agent-session-bus')), false);
});

test('native Pi injection checks inherited context and respects override-file precedence', (t) => {
  const f = fixture(t);
  const parent = path.dirname(f.cwd);
  const inherited = path.join(parent, 'AGENTS.md');
  fs.writeFileSync(inherited, legacy('opencode:old', 'P'.repeat(2239848)));
  fs.writeFileSync(f.file, 'inactive regular AGENTS content'.repeat(100000));
  const override = path.join(f.cwd, 'AGENTS.override.md');
  fs.writeFileSync(override, '# Override rules\n');
  const result = inject({ ...f.opts, mode: 'native' });
  assert.ok(fs.readFileSync(inherited, 'utf8').length < 4096);
  assert.ok(result.contextRepairs.some((r) => r.file === inherited));
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'inactive regular AGENTS content'.repeat(100000));
  assert.equal(fs.readFileSync(override, 'utf8'), '# Override rules\n');
});

test('native Pi injection leaves shadowed main-worktree instructions untouched', (t) => {
  const f = fixture(t);
  const main = path.dirname(f.cwd);
  const git = path.join(main, '.git');
  const gitDir = path.join(git, 'worktrees', 'nested');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/nested\n');
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(f.cwd, '.git'), `gitdir: ${gitDir}\n`);
  const shadowed = path.join(main, 'AGENTS.md');
  const old = legacy('pi:ignored', 'L'.repeat(2239848));
  fs.writeFileSync(shadowed, old);
  fs.writeFileSync(f.file, '# Worktree rules\n');
  const result = inject({ ...f.opts, mode: 'native' });
  assert.ok(fs.readFileSync(shadowed, 'utf8') === old, 'shadowed main-worktree file was modified');
  assert.equal(result.contextRepairs.some((r) => r.file === shadowed), false);
  fs.writeFileSync(shadowed, '# Ignored ordinary instructions\n' + 'X'.repeat(2239848));
  assert.doesNotThrow(() => inject({ ...f.opts, mode: 'native' }));
});

test('native Pi context discovery accepts uppercase Markdown extensions', (t) => {
  const f = fixture(t);
  const upper = path.join(f.cwd, 'AGENTS.MD');
  fs.writeFileSync(upper, legacy('pi:uppercase', 'L'.repeat(2239848)));
  inject({ ...f.opts, mode: 'native' });
  assert.ok(fs.readFileSync(upper, 'utf8').length < 4096);
});

test('oversized unmarked project rules block native injection without destructive truncation', (t) => {
  const f = fixture(t);
  const old = '# Genuine instructions\n' + 'R'.repeat(2239848);
  fs.writeFileSync(f.file, old);
  assert.throws(() => inject({ ...f.opts, mode: 'native' }), /instructions|context files/i);
  assert.equal(fs.readFileSync(f.file, 'utf8'), old);
  assert.equal(fs.readdirSync(path.join(process.env.PI_CODING_AGENT_DIR, 'sessions')).length, 1);
});

test('dry-run leaves both the context and archive directory unchanged', (t) => {
  const f = fixture(t);
  const old = legacy('opencode:ses_old', 'legacy history');
  fs.writeFileSync(f.file, old);
  const result = inject({ ...f.opts, dryRun: true });
  assert.equal(result.wrote, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), old);
  assert.equal(fs.existsSync(path.join(f.cwd, '.agent-session-bus')), false);
});

test('unterminated legacy blocks are rejected without overwriting user instructions', (t) => {
  const f = fixture(t);
  const old = '# Rules\n<!-- agent-session-bus: pi:broken -->\nNo closing marker';
  fs.writeFileSync(f.file, old);
  assert.throws(() => inject(f.opts), /unterminated|unclosed/i);
  assert.equal(fs.readFileSync(f.file, 'utf8'), old);
});

test('repair-context CLI archives existing history without needing the source session', (t) => {
  const f = fixture(t);
  const old = legacy('opencode:ses_deleted', 'Keep this transcript exactly.');
  fs.writeFileSync(f.file, old);
  const cmd = () => spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'repair-context', '--cwd', f.cwd], { encoding: 'utf8' });
  const result = cmd();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(fs.readFileSync(report.backup, 'utf8'), old);
  assert.equal(report.archivedFiles.length, 1);
  assert.equal(fs.readFileSync(report.archivedFiles[0], 'utf8'), old);
  const fixed = fs.readFileSync(f.file, 'utf8');
  const second = cmd();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).wrote, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), fixed);
});

test('explicit recovery archives unclosed legacy blocks without losing any text', (t) => {
  const f = fixture(t);
  const first = '<!-- agent-session-bus: opencode:ses_unclosed -->\nKeep the first history.\n\n';
  const second = legacy('pi:other', 'Keep the second history.');
  const old = '# Original rules\n' + first + second + '\nTrailing rules\n';
  fs.writeFileSync(f.file, old);
  const result = spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'repair-context', '--cwd', f.cwd, '--recover'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.recoveredBlocks, 1);
  assert.equal(fs.readFileSync(report.backup, 'utf8'), old);
  const archived = report.archivedFiles.map((file) => fs.readFileSync(file, 'utf8'));
  assert.ok(archived.includes(first));
  assert.ok(archived.includes(second));
  const context = fs.readFileSync(f.file, 'utf8');
  assert.ok(context.startsWith('# Original rules\n'));
  assert.ok(context.endsWith('\nTrailing rules\n'));
  assert.ok(!context.includes('Keep the first history.'));
});

test('surplus closing markers cannot leave a large imported tail in system context', (t) => {
  const f = fixture(t);
  const old = legacy('pi:ambiguous', 'first fragment') + '\n' + 'X'.repeat(1200000) + '\n<!-- /agent-session-bus -->\n# Trailing rules\n';
  fs.writeFileSync(f.file, old);
  assert.throws(() => inject(f.opts), /closing|ambiguous/i);
  assert.equal(fs.readFileSync(f.file, 'utf8'), old);
  const result = spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'repair-context', '--cwd', f.cwd, '--recover'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(fs.readFileSync(report.backup, 'utf8'), old);
  assert.ok(fs.readFileSync(f.file, 'utf8').length < 4096);
  assert.ok(fs.readFileSync(report.archivedFiles[0], 'utf8').includes('X'.repeat(1200000)));
  assert.ok(fs.readFileSync(f.file, 'utf8').endsWith('# Trailing rules\n'));
});

test('recovering an unclosed reference produces a well-formed idempotent reference', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '<!-- agent-session-bus: pi:unfinished -->\n<!-- agent-session-bus-reference -->\nUnclosed reference text');
  const cmd = () => spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'repair-context', '--cwd', f.cwd, '--recover'], { encoding: 'utf8' });
  const result = cmd();
  assert.equal(result.status, 0, result.stderr);
  const fixed = fs.readFileSync(f.file, 'utf8');
  assert.ok(fixed.includes('<!-- /agent-session-bus -->'));
  const second = cmd();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).wrote, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), fixed);
  assert.doesNotThrow(() => inject(f.opts));
});

test('context archive retains full tool inputs and outputs', (t) => {
  const f = fixture(t);
  const source = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', 'tools.jsonl');
  fs.writeFileSync(source, [
    { type: 'session', version: 3, id: 'tools', cwd: f.cwd },
    { type: 'message', id: '11111111', parentId: null, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'write', arguments: { path: 'x', content: 'A'.repeat(10000) } }] } },
    { type: 'message', id: '22222222', parentId: '11111111', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'write', content: [{ type: 'text', text: 'B'.repeat(10000) }] } },
  ].map(JSON.stringify).join('\n'));
  const result = inject({ ...f.opts, fromId: 'tools' });
  const archive = fs.readFileSync(result.transcriptFile, 'utf8');
  assert.ok(archive.includes('A'.repeat(10000)));
  assert.ok(archive.includes('B'.repeat(10000)));
});
