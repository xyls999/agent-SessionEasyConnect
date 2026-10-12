'use strict';
// Optional integration check against an installed Pi. Never calls a remote model,
// never writes a live session: the real Codex request builder is driven through
// a local SSE fixture and all outgoing field sizes are checked before transport.
// Usage: node test/pi-request-contract.cjs <pi-package-dir> [agent:session-id]
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const A = require('../src/adapters');
const R = require('../src/render');
const U = require('../src/util');

(async () => {
  if (!process.argv[2]) throw new Error('usage: node test/pi-request-contract.cjs <pi-package-dir> [agent:session-id]');
  const pkg = path.resolve(process.argv[2]);
  const load = (file) => import(pathToFileURL(path.join(pkg, file)).href);
  const ir = process.argv[3] ? A.read(...process.argv[3].split(':')) : {
    agent: 'opencode', session_id: 'contract-fixture', cwd: process.cwd(), messages: [
      { role: 'user', parts: [{ type: 'text', text: 'H'.repeat(13394773) }] },
      { role: 'assistant', is_summary: true, id: 'source-summary', parts: [{ type: 'text', text: 'Actual source fixture checkpoint.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Recent task. ' + 'P'.repeat(100000) }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Recent progress. ' + 'A'.repeat(100000) }] },
      { role: 'user', parts: [{ type: 'text', text: 'Continue the recent task.' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Current tail. ' + 'R'.repeat(100000) }] },
    ],
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-pi-contract-'));
  try {
    const generated = R.genPi(ir, { provider: 'openai-codex', model: 'contract-test' });
    const file = path.join(temp, 'session.jsonl');
    fs.writeFileSync(file, generated.content);
    const records = generated.content.trim().split('\n').map(JSON.parse);
    const { SessionManager } = await load('dist/core/session-manager.js');
    const session = SessionManager.open(file);
    const context = session.buildSessionContext();
    const latest = ir.messages.filter((m) => m.is_summary).at(-1);
    if (latest) {
      assert.equal(context.messages[0].role, 'compactionSummary');
      assert.equal(context.messages[0].summary, latest.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim());
    }
    assert.equal(records.filter((r) => r.type === 'compaction').length, ir.messages.filter((m) => m.is_summary).length);
    const sourceOutputs = ir.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result').map((p) => String(p.output ?? '')).sort();
    const nativeOutputs = records.filter((r) => r.message?.role === 'toolResult').map((r) => r.message.content[0].text).sort();
    const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
    assert.deepEqual(nativeOutputs.map(digest), sourceOutputs.map(digest), 'full historical tool outputs must still be on disk');

    const model = { id: 'contract-test', name: 'Contract test', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://example.invalid', reasoning: false, input: ['text', 'image'], contextWindow: 1050000, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'local-fixture' } })).toString('base64url') + '.fixture';
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_fixture', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'Local fixture only; not a persisted summary.' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Local fixture only; not a persisted summary.', annotations: [] }] } },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
    ];
    const streamText = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
    const captures = [];
    let phase = 'compaction';
    const { stream } = await load('node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js');
    const request = (m, c, options) => stream(m, c, {
      ...options, apiKey: token, transport: 'sse', maxRetries: 0,
      onPayload: (body) => {
        assert.ok(body.instructions.length <= 1048576, `instructions too long: ${body.instructions.length}`);
        const texts = body.input.flatMap((item) => Array.isArray(item.content) ? item.content.filter((p) => typeof p.text === 'string').map((p) => p.text.length) : []);
        assert.ok(texts.every((n) => n <= 10485760), `input text too long: ${Math.max(...texts)}`);
        const callIds = new Set();
        for (const item of body.input) {
          if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            assert.match(item.call_id, /^[A-Za-z0-9_-]{1,64}$/);
            assert.ok((item.arguments || item.input || '').length <= 10485760, 'tool arguments exceed the API field limit');
            callIds.add(item.call_id);
          }
          if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
            assert.ok(callIds.has(item.call_id), `active replay contains an orphan output: ${item.call_id}`);
          }
        }
        captures.push({ phase, instructionsCharacters: body.instructions.length, maximumInputTextCharacters: Math.max(0, ...texts), inputItems: body.input.length });
      },
      fetch: async () => new Response(streamText, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    });
    const { compact, prepareCompaction, DEFAULT_COMPACTION_SETTINGS } = await load('dist/core/compaction/compaction.js');
    const preparation = prepareCompaction(session.getBranch(), DEFAULT_COMPACTION_SETTINGS);
    if (preparation) await compact(preparation, model, token, undefined, undefined, undefined, undefined, request);
    const { convertToLlm } = await load('dist/core/messages.js');
    const { loadProjectContextFiles } = await load('dist/core/resource-loader.js');
    const { buildSystemPrompt } = await load('dist/core/system-prompt.js');
    const contextFiles = loadProjectContextFiles({ cwd: ir.cwd || process.cwd(), agentDir: U.roots().pi });
    const systemPrompt = buildSystemPrompt({ cwd: ir.cwd || process.cwd(), contextFiles, selectedTools: ['read', 'bash'] });
    phase = 'normal-resume';
    const response = await request(model, { systemPrompt, messages: convertToLlm(context.messages) }, {}).result();
    assert.equal(response.stopReason, 'stop', response.errorMessage);
    assert.ok(captures.some((r) => r.phase === 'normal-resume'));
    console.log(`PASS: ${preparation ? 'real Pi compact() + normal resume' : 'normal resume (no eligible compaction span)'} -> Codex request builder -> local SSE contract`);
    console.log(JSON.stringify({ sourceMessages: ir.messages.length, historicalToolResultsPreserved: nativeOutputs.length, checkpoints: generated.checkpoints, activeContextMessages: context.messages.length, estimatedActiveCharacters: generated.activeCharacters, requests: captures }, null, 2));
    console.log('No remote inference performed; fixture summaries were not persisted.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
