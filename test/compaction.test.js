'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ocRead, piRead } = require('../src/adapters');
const { genPi } = require('../src/render');

function source(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-compaction-'));
  const previous = process.env.OPENCODE_DATA;
  process.env.OPENCODE_DATA = dir;
  let db;
  t.after(() => { if (db) db.close(); if (previous === undefined) delete process.env.OPENCODE_DATA; else process.env.OPENCODE_DATA = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec('CREATE TABLE session(id TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, title TEXT); CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, data TEXT);');
  db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run('source', dir, '{}', 1789368195269, 1789368195279, 'test');
  const add = (id, data, parts) => {
    db.prepare('INSERT INTO message VALUES(?,?,?,?)').run(id, 'source', 1789368195269 + Number(id), JSON.stringify(data));
    for (let i = 0; i < parts.length; i++) db.prepare('INSERT INTO part VALUES(?,?,?,?)').run(id + '_' + i, id, 'source', JSON.stringify(parts[i]));
  };
  return { add };
}

function rows(messages) {
  return genPi({ agent: 'opencode', session_id: 'source', cwd: 'E:/test', messages }).content.trim().split('\n').map(JSON.parse);
}

test('OpenCode reader recognizes only successful assistant compaction summaries', (t) => {
  const s = source(t);
  s.add('1', { role: 'user', summary: { diffs: [] } }, [{ type: 'text', text: 'request' }]);
  s.add('2', { role: 'assistant', summary: true, finish: 'stop' }, [{ type: 'text', text: 'Verified source checkpoint' }]);
  s.add('3', { role: 'assistant', summary: true, finish: 'length', error: { name: 'OutputLengthError' } }, [{ type: 'text', text: 'partial summary' }]);
  s.add('4', { role: 'assistant', summary: { diffs: [] }, finish: 'stop' }, [{ type: 'text', text: 'ordinary reply' }]);
  const summaries = ocRead('source').messages.filter((m) => m.is_summary);
  assert.deepEqual(summaries.map((m) => m.id), ['2']);
  assert.equal(summaries[0].parts[0].text, 'Verified source checkpoint');
});

test('Pi native history keeps old messages but its checkpoint excludes them from active replay', () => {
  const result = rows([
    { role: 'user', parts: [{ type: 'text', text: 'old history' }] },
    { role: 'assistant', is_summary: true, id: 'summary-source', parts: [{ type: 'text', text: 'Actual source summary' }] },
    { role: 'user', parts: [{ type: 'text', text: 'current request' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c', name: 'read', input: {} }, { type: 'tool_result', id: 'c', output: 'current data' }] },
  ]);
  const checkpoint = result.find((r) => r.type === 'compaction');
  assert.ok(checkpoint, 'source compaction boundary was dropped');
  assert.equal(checkpoint.summary, 'Actual source summary');
  assert.equal(checkpoint.details.sourceMessageId, 'summary-source');
  const current = result.find((r) => r.message?.content?.[0]?.text === 'current request');
  assert.equal(checkpoint.firstKeptEntryId, current.id);
  assert.ok(result.some((r) => r.message?.content?.[0]?.text === 'old history'));
  assert.ok(result.indexOf(current) > result.indexOf(checkpoint));
});

test('large compacted histories can be imported without discarding their original bytes', () => {
  const old = 'H'.repeat(13394773);
  const result = rows([
    { role: 'user', parts: [{ type: 'text', text: old }] },
    { role: 'assistant', is_summary: true, parts: [{ type: 'text', text: 'Source already summarized the large history.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'continue' }] },
  ]);
  assert.equal(result.filter((r) => r.type === 'compaction').length, 1);
  assert.equal(result.find((r) => r.message?.role === 'user').message.content[0].text, old);
});

test('Pi reader carries legacy compaction checkpoints and their kept tail through reinjection', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-pi-checkpoint-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, 'sessions'));
  const source = [
    { type: 'session', version: 3, id: 'legacy', cwd: dir },
    { type: 'message', id: '11111111', parentId: null, message: { role: 'user', content: 'old task' } },
    { type: 'message', id: '22222222', parentId: '11111111', message: { role: 'user', content: 'recent task' } },
    { type: 'message', id: '33333333', parentId: '22222222', message: { role: 'assistant', content: [{ type: 'text', text: 'recent reply' }] } },
    { type: 'compaction', id: '44444444', parentId: '33333333', firstKeptEntryId: '22222222', summary: 'Actual Pi checkpoint', tokensBefore: 10 },
    { type: 'message', id: '55555555', parentId: '44444444', message: { role: 'user', content: 'continue' } },
  ];
  fs.writeFileSync(path.join(dir, 'sessions', 'legacy.jsonl'), source.map(JSON.stringify).join('\n'));
  const canonical = piRead('legacy');
  const checkpoint = canonical.messages.findIndex((m) => m.is_summary);
  assert.ok(checkpoint >= 0, 'Pi reader dropped its source checkpoint');
  assert.deepEqual(canonical.messages.slice(checkpoint + 1).map((m) => m.parts[0].text), ['recent task', 'recent reply', 'continue']);
  const generated = genPi(canonical).content.trim().split('\n').map(JSON.parse);
  const nativeCheckpoint = generated.findIndex((r) => r.type === 'compaction');
  assert.deepEqual(generated.slice(nativeCheckpoint + 1).filter((r) => r.type === 'message').map((r) => r.message.content[0].text), ['recent task', 'recent reply', 'continue']);
});

test('Pi checkpoint boundaries at metadata entries retain the following messages', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-pi-metadata-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', 'metadata.jsonl'), [
    { type: 'session', version: 3, id: 'metadata', cwd: dir },
    { type: 'message', id: '11111111', parentId: null, message: { role: 'user', content: 'old' } },
    { type: 'model_change', id: '99999999', parentId: '11111111', provider: 'openai', modelId: 'target' },
    { type: 'message', id: '22222222', parentId: '99999999', message: { role: 'user', content: 'recent task' } },
    { type: 'message', id: '33333333', parentId: '22222222', message: { role: 'assistant', content: [{ type: 'text', text: 'recent reply' }] } },
    { type: 'compaction', id: '44444444', parentId: '33333333', firstKeptEntryId: '99999999', summary: 'latest summary', tokensBefore: 10 },
    { type: 'message', id: '55555555', parentId: '44444444', message: { role: 'user', content: 'continue' } },
  ].map(JSON.stringify).join('\n'));
  const canonical = piRead('metadata');
  const checkpoint = canonical.messages.findIndex((m) => m.is_summary);
  assert.deepEqual(canonical.messages.slice(checkpoint + 1).map((m) => m.parts[0].text), ['recent task', 'recent reply', 'continue']);
});

test('repeated Pi compactions keep the newest checkpoint operative without expanded-tail duplication', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-pi-repeated-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', 'repeated.jsonl'), [
    { type: 'session', version: 3, id: 'repeated', cwd: dir },
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'A' } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'B' } },
    { type: 'message', id: 'c', parentId: 'b', message: { role: 'user', content: 'C' } },
    { type: 'compaction', id: 'k1', parentId: 'c', firstKeptEntryId: 'b', summary: 'S1', tokensBefore: 10 },
    { type: 'message', id: 'd', parentId: 'k1', message: { role: 'user', content: 'D' } },
    { type: 'compaction', id: 'k2', parentId: 'd', firstKeptEntryId: 'c', summary: 'S2', tokensBefore: 10 },
    { type: 'message', id: 'e', parentId: 'k2', message: { role: 'user', content: 'E' } },
  ].map(JSON.stringify).join('\n'));
  const canonical = piRead('repeated');
  assert.deepEqual(canonical.messages.filter((m) => m.is_summary).map((m) => m.parts[0].text), ['S1', 'S2']);
  const result = genPi(canonical).content.trim().split('\n').map(JSON.parse);
  const latest = result.findLastIndex((r) => r.type === 'compaction');
  assert.equal(result[latest].summary, 'S2');
  const active = result.slice(latest + 1).filter((r) => r.type === 'message').map((r) => r.message.content[0].text);
  assert.equal(active.filter((s) => s === 'C').length, 1);
  assert.equal(active.filter((s) => s === 'D').length, 1);
  assert.equal(active.filter((s) => s === 'B').length, 0);
  assert.equal(active.at(-1), 'E');
  assert.ok(active.some((s) => s.includes('S1')));
});

test('oversized active history with no checkpoint is rejected before creating an unusable session', () => {
  assert.throws(() => rows([{ role: 'user', parts: [{ type: 'text', text: 'X'.repeat(13394773) }] }]), /active.*context|checkpoint|context mode/i);
});

test('an oversized source summary is not silently truncated or replayed', () => {
  assert.throws(() => rows([{ role: 'assistant', is_summary: true, parts: [{ type: 'text', text: 'S'.repeat(13394773) }] }]), /active.*context|checkpoint|context mode/i);
});
