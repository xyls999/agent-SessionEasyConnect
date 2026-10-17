'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { injectNative, tailMessages } = require('../src/inject');
const { genOpenCodeImport } = require('../src/render');

test('tailMessages keeps the last N and snaps the start forward to a user turn', () => {
  const msgs = [
    { role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' },
  ];
  assert.deepEqual(tailMessages(msgs, 5), [msgs[2], msgs[3], msgs[4], msgs[5], msgs[6]]); // start=2 already a user turn
  assert.deepEqual(tailMessages(msgs, 3), [msgs[5], msgs[6]]); // start=4 (assistant) snaps to 5 (user)
  assert.deepEqual(tailMessages(msgs, 20), msgs); // under budget: untouched
  const noUserTail = [{ role: 'user' }, { role: 'assistant' }, { role: 'assistant' }];
  assert.deepEqual(tailMessages(noUserTail, 2), noUserTail); // no user boundary in window: keep all
});

const ir = (over) => ({
  agent: 'pi', cwd: 'E:/tmp-issac', model: 'gpt-test', title: 'demo session',
  created_at: 1000, updated_at: 2000,
  messages: [
    { role: 'user', ts: 1000, parts: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', ts: 2000, parts: [{ type: 'text', text: 'hi' }] },
  ],
  ...over,
});

test('opencode native inject auto-runs opencode import from the session directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-oc-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'import.json');
  let seen = null;
  const res = injectNative('opencode', ir(), { targetModel: false,
    out,
    runImport: (file, cwd) => { seen = { file, cwd }; return { ok: true, sid: 'ses_returned' }; },
  });
  assert.equal(res.imported, true);
  assert.equal(res.sid, 'ses_returned');
  assert.deepEqual(seen, { file: out, cwd: 'E:/tmp-issac' });
  assert.equal(res.file, out);
  assert.match(res.note, /imported into opencode\.db/);
  assert.ok(fs.existsSync(out), '--out file is kept as backup');
});

test('default temp import JSON is removed after a successful import', (t) => {
  const res = injectNative('opencode', ir(), { targetModel: false, runImport: () => ({ ok: true, sid: 'ses_x' }) });
  t.after(() => { try { fs.rmSync(res.file, { force: true }); } catch { /* already removed */ } });
  assert.equal(res.imported, true);
  assert.match(res.note, /auto-removed/);
  assert.equal(fs.existsSync(res.file), false);
});

test('--keep-file keeps the default temp JSON', (t) => {
  const res = injectNative('opencode', ir(), { targetModel: false, keepFile: true, runImport: () => ({ ok: true }) });
  t.after(() => fs.rmSync(res.file, { force: true }));
  assert.ok(fs.existsSync(res.file));
});

test('failed auto-import keeps the JSON and returns a manual hint', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-oc-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'import.json');
  const res = injectNative('opencode', ir(), { targetModel: false, out, runImport: () => ({ ok: false, reason: 'opencode CLI not found' }) });
  assert.equal(res.imported, false);
  assert.match(res.note, /auto-import FAILED: opencode CLI not found/);
  assert.match(res.hint, /^opencode import "/);
  assert.ok(fs.existsSync(out));
});

test('--no-import only writes the JSON and never runs opencode', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-oc-noimport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'import.json');
  let ran = false;
  const res = injectNative('opencode', ir(), { targetModel: false, out, noImport: true, runImport: () => { ran = true; return { ok: true }; } });
  assert.equal(ran, false);
  assert.equal(res.imported, undefined);
  assert.match(res.hint, /^opencode import "/);
  assert.match(res.note, /session directory \(E:\/tmp-issac\)/);
  assert.ok(fs.existsSync(out));
});

test('dry-run writes nothing and does not import', () => {
  const res = injectNative('opencode', ir(), { targetModel: false, dryRun: true, runImport: () => ({ ok: true }) });
  assert.equal(res.wrote, false);
  assert.equal(res.imported, undefined);
});

test('untitled sources get a derived session title from the first user message', () => {
  const out = JSON.parse(genOpenCodeImport(ir({ title: null, messages: [{ role: 'user', ts: 1, parts: [{ type: 'text', text: '  多行\n\n标题 ' }] }] })).content);
  assert.equal(out.info.title, '多行 标题');
});

test('resolved target model replaces the phantom imported provider everywhere', () => {
  const out = JSON.parse(genOpenCodeImport(ir(), { providerID: 'opencode-go', modelID: 'qwen3.8-flash' }).content);
  assert.deepEqual(out.info.model, { id: 'qwen3.8-flash', providerID: 'opencode-go' });
  const dump = JSON.stringify(out.messages);
  assert.equal(dump.includes('"imported"'), false);
  assert.ok(out.messages.every((m) => !m.info.providerID || m.info.providerID === 'opencode-go'));
});

test('--model provider/id is parsed and threaded into the generated session', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-oc-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'import.json');
  injectNative('opencode', ir(), { out, model: 'opencode-go/qwen3.8-flash', runImport: () => ({ ok: true }) });
  const info = JSON.parse(fs.readFileSync(out, 'utf8')).info;
  assert.deepEqual(info.model, { id: 'qwen3.8-flash', providerID: 'opencode-go' });
  assert.throws(() => injectNative('opencode', ir(), { out, model: 'nodelimiter' }), /provider\/model/);
});

test('--tail imports only the last turns, starting at a user boundary', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-oc-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'import.json');
  const many = [];
  for (let i = 0; i < 50; i++) {
    if (i % 2 === 0) many.push({ role: 'user', ts: i, parts: [{ type: 'text', text: 'q' + i }] });
    else many.push({ role: 'assistant', ts: i, parts: [{ type: 'text', text: 'a' + i }] });
  }
  const res = injectNative('opencode', ir({ messages: many }), { out, targetModel: false, tail: 5, runImport: () => ({ ok: true }) });
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(doc.messages.length <= 5);
  assert.equal(doc.messages[0].info.role, 'user');
  assert.match(res.note, /trimmed: imported \d+ of 50 messages/);
  assert.match(doc.info.title, /^demo session — last 5 turns$/);
});

test('--max-kb trims the kept tail to a byte budget, keeping the live turn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-oc-kb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'import.json');
  const big = [];
  for (let i = 0; i < 30; i++) {
    big.push({ role: i % 2 ? 'assistant' : 'user', ts: i, parts: [{ type: 'text', text: 'y'.repeat(10000) }] });
  }
  const res = injectNative('opencode', ir({ messages: big }), { out, targetModel: false, maxKb: 40, runImport: () => ({ ok: true }) });
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(doc.messages.length < 30);
  assert.equal(doc.messages[0].info.role, 'user');
  assert.match(doc.info.title, /— recent turns \(≤40KB\)$/);
  assert.throws(() => injectNative('opencode', ir(), { out, targetModel: false, maxKb: '-5', runImport: () => ({ ok: true }) }), /positive/);
});

test('huge untailored opencode imports carry a continue-chat size warning', () => {
  const big = [];
  for (let i = 0; i < 300; i++) big.push({ role: i % 2 ? 'assistant' : 'user', ts: i, parts: [{ type: 'text', text: 'x'.repeat(30000) }] });
  const res = injectNative('opencode', ir({ messages: big }), { dryRun: true, targetModel: false });
  assert.match(res.note, /WARNING: history ~\d+(\.\d+)?MB/);
  assert.match(res.note, /--tail N/);
});

