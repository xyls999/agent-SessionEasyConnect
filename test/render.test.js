'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { genPi, genClaude, genCodex } = require('../src/render');
const adapters = require('../src/adapters');

const ir = (messages) => ({ agent: 'opencode', session_id: 'ses_source', cwd: 'E:/project', model: 'foreign-model', messages });
const rows = (messages) => genPi(ir(messages)).content.trim().split('\n').map(JSON.parse);
const messages = (input) => rows(input).filter((r) => r.type === 'message').map((r) => r.message);

test('OpenCode inline tool results become standalone Pi messages in order', () => {
  const result = messages([{ role: 'assistant', parts: [
    { type: 'text', text: 'Reading' },
    { type: 'tool_call', id: 'call_1', name: 'read', input: { filePath: 'x' } },
    { type: 'tool_result', id: 'call_1', name: 'read', output: 'file contents' },
    { type: 'text', text: 'Finished' },
  ] }]);
  assert.deepEqual(result.map((m) => m.role), ['assistant', 'toolResult', 'assistant']);
  assert.equal(result[0].stopReason, 'toolUse');
  assert.equal(result[1].toolCallId, result[0].content[1].id);
  assert.equal(result[1].toolName, 'read');
  assert.equal(result[1].content[0].text, 'file contents');
  assert.equal(result[2].content[0].text, 'Finished');
});

test('separate tool results retain names and paired portable call IDs', () => {
  const id = 'call_' + 'x'.repeat(80) + '|fc_remote';
  const result = messages([
    { role: 'assistant', parts: [{ type: 'tool_call', id, name: 'bash', input: { command: 'echo ok' } }] },
    { role: 'tool', parts: [{ type: 'tool_result', id, output: 'failed', is_error: true }] },
  ]);
  assert.match(result[0].content[0].id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(result[1].toolCallId, result[0].content[0].id);
  assert.equal(result[1].toolName, 'bash');
  assert.equal(result[1].isError, true);
});

test('missing tool IDs are paired when the result immediately follows the call', () => {
  const result = messages([{ role: 'assistant', parts: [
    { type: 'tool_call', name: 'read', input: {} },
    { type: 'tool_result', name: 'read', output: 'ok' },
  ] }]);
  assert.equal(result.length, 2);
  assert.equal(result[1].toolCallId, result[0].content[0].id);
});

test('imports do not select a nonexistent imported provider/model', () => {
  assert.equal(rows([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }]).some((r) => r.type === 'model_change' && r.provider === 'imported'), false);
});

test('historical system text is preserved without impersonating an assistant', () => {
  const result = messages([{ role: 'system', parts: [{ type: 'text', text: 'source instructions' }] }]);
  assert.equal(result[0].role, 'user');
  assert.match(result[0].content[0].text, /source instructions/);
});

test('OpenCode inline tool results also survive native Claude conversion', () => {
  const output = genClaude(ir([{ role: 'assistant', parts: [
    { type: 'tool_call', id: 'call_1', name: 'read', input: {} },
    { type: 'tool_result', id: 'call_1', name: 'read', output: 'read failed', is_error: true },
    { type: 'text', text: 'Acknowledged' },
  ] }])).content.trim().split('\n').map(JSON.parse);
  assert.deepEqual(output.map((r) => r.type), ['assistant', 'user', 'assistant']);
  assert.equal(output[1].message.content[0].type, 'tool_result');
  assert.equal(output[1].message.content[0].tool_use_id, output[0].message.content[0].id);
  assert.equal(output[1].message.content[0].content[0].text, 'read failed');
  assert.equal(output[1].message.content[0].is_error, true);
  assert.equal(output[2].message.content[0].text, 'Acknowledged');
  assert.equal(output[1].parentUuid, output[0].uuid);
});

test('Codex conversion keeps portable paired IDs without replaying foreign reasoning', () => {
  const source = 'call_' + 'y'.repeat(80) + '|fc_foreign';
  const output = genCodex(ir([{ role: 'assistant', parts: [
    { type: 'reasoning', text: 'foreign reasoning' },
    { type: 'tool_call', id: source, name: 'read', input: {} },
    { type: 'tool_result', id: source, output: 'ok' },
  ] }])).content.trim().split('\n').map(JSON.parse);
  const response = output.filter((r) => r.type === 'response_item').map((r) => r.payload);
  assert.equal(response.some((p) => p.type === 'reasoning'), false);
  assert.match(response[0].call_id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(response[1].call_id, response[0].call_id);
  assert.equal(response[1].output, 'ok');
});

test('orphan results are preserved as historical text rather than invalid API tool responses', () => {
  const result = messages([{ role: 'tool', parts: [{ type: 'tool_result', id: 'orphan', name: 'read', output: 'historical output' }] }]);
  assert.equal(result[0].role, 'user');
  assert.match(result[0].content[0].text, /historical output/);
});

test('distinct long call IDs do not collide after normalization', () => {
  const result = messages([{ role: 'assistant', parts: [
    { type: 'tool_call', id: 'x'.repeat(70) + 'a', name: 'read', input: {} },
    { type: 'tool_result', id: 'x'.repeat(70) + 'a', output: 'first' },
    { type: 'tool_call', id: 'x'.repeat(70) + 'b', name: 'read', input: {} },
    { type: 'tool_result', id: 'x'.repeat(70) + 'b', output: 'second' },
  ] }]);
  assert.notEqual(result[0].content[0].id, result[2].content[0].id);
  assert.equal(result[1].toolCallId, result[0].content[0].id);
  assert.equal(result[3].toolCallId, result[2].content[0].id);
});

test('Pi records keep a valid unique parent chain', () => {
  const result = rows([{ role: 'assistant', parts: [
    { type: 'tool_call', id: 'a', name: 'read', input: {} },
    { type: 'tool_result', id: 'a', output: '' },
  ] }]);
  const seen = new Set();
  let prev = null;
  for (const r of result.slice(1)) {
    assert.match(r.id, /^[0-9a-f]{8}$/);
    assert.equal(r.parentId, prev);
    assert.equal(seen.has(r.id), false);
    seen.add(r.id); prev = r.id;
  }
});

test('Pi reader accepts native string user content', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-reader-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', 'native-string.jsonl'), [
    { type: 'session', version: 3, id: 'native-string', cwd: 'E:/project' },
    { type: 'message', id: '12345678', parentId: null, message: { role: 'user', content: '你好，继续任务', timestamp: 1789368195269 } },
  ].map(JSON.stringify).join('\n'));
  assert.deepEqual(adapters.piRead('native-string').messages[0].parts, [{ type: 'text', text: '你好，继续任务' }]);
});
