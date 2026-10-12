'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { handler } = require('../src/server');

test('web injection errors are returned as JSON instead of unhandled promise rejections', async (t) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(url + '/api/inject', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromAgent: 'pi', fromId: 'source', to: 'not-an-agent', mode: 'context' }),
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /unknown target agent/);
  assert.equal((await fetch(url + '/api/roots')).status, 200);
});
