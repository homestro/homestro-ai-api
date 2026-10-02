'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerSidekickApi } = require('../sidekick-api');
const { validateProductEconomics } = require('../homestro-rules');

async function fixture() {
  const app = express();
  app.use(express.json());
  const pass = (_req, _res, next) => next();
  const state = { running: false, lastRun: null, lastError: null, created: 0, rejected: 0, failed: 0 };
  let runs = 0;
  registerSidekickApi(app, {
    sidekick: pass, apiKey: pass, catalogState: state, catalogInterval: () => 300000,
    catalogRun: async () => { runs += 1; }, validateProduct: body => validateProductEconomics(body, {})
  });
  const server = await new Promise(resolve => { const value = app.listen(0, () => resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, runs: () => runs, close: () => new Promise(resolve => server.close(resolve)) };
}

test('Sidekick task endpoints queue, lease, complete and report tasks', async t => {
  const f = await fixture(); t.after(f.close);
  let response = await fetch(f.base + '/api/sidekick/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'inspect' }) });
  assert.equal(response.status, 201); const queued = await response.json();
  response = await fetch(f.base + '/api/sidekick/tasks/next'); const leased = await response.json();
  assert.equal(leased.task.id, queued.task.id); assert.equal(leased.task.status, 'leased');
  response = await fetch(f.base + `/api/sidekick/tasks/${queued.task.id}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"done":true}' });
  assert.equal(response.status, 200);
  response = await fetch(f.base + '/api/sidekick/tasks/status');
  assert.deepEqual(await response.json(), { ok: true, queued: 0, leased: 0, completed: 1 });
});

test('Sidekick automation and centralized validation endpoints exist', async t => {
  const f = await fixture(); t.after(f.close);
  let response = await fetch(f.base + '/api/sidekick/automation/status');
  assert.equal(response.status, 200); assert.equal((await response.json()).intervalMs, 300000);
  response = await fetch(f.base + '/api/sidekick/automation/run', { method: 'POST' });
  assert.deepEqual(await response.json(), { ok: true, started: true }); assert.equal(f.runs(), 1);
  response = await fetch(f.base + '/api/sidekick/products/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"cost":10,"sellingPrice":35}' });
  assert.equal((await response.json()).valid, true);
});
