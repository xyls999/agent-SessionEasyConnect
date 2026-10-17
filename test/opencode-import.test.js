'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { injectNative } = require('../src/inject');
const { genOpenCodeImport } = require('../src/render');

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

