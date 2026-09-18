import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApiServer } from '../server/api.mjs';
import { createStore } from '../server/store.mjs';

function temporaryDirectory(t) {
  const base = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, 'square-storage-recovery-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), base);
    assert.ok(path.basename(directory).startsWith('square-storage-recovery-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const locked = () => Object.assign(new Error('simulated temporary file lock'), { code: 'EPERM' });

async function fixture(t) {
  const directory = temporaryDirectory(t);
  let upstreamCalls = 0;
  const app = createApiServer({ dataDirectory: directory, fetchImpl: async () => {
    upstreamCalls++;
    return new Response(JSON.stringify({ code: '000000', data: { id: String(1000 + upstreamCalls) } }));
  }});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  async function request(route, body) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const accounts = [];
  for (let n = 0; n < 2; n++) {
    accounts.push((await request('/accounts', { name: `test-${n}`, apiKey: `FAKE_TEST_KEY_${n}_0123456789` })).body.account.id);
  }
  const content = { requestId: randomUUID(), accountIds: accounts, type: 'post', body: 'storage fault test', mediaIds: [], demo: false };
  return { ...app, directory, request, content, calls: () => upstreamCalls };
}

test('failed initial ledger save rolls back the unstarted job and allows a safe same-id retry', async t => {
  const app = await fixture(t);
  const originalSave = app.store.save;
  app.store.save = () => { throw locked(); };
  const failed = await app.request('/publish', app.content);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'STORAGE_ERROR');
  assert.equal(app.calls(), 0);
  assert.equal(app.store.data.history.length, 0);
  app.store.save = originalSave;
  const retry = await app.request('/publish', app.content);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.results.map(result => result.status), ['success', 'success']);
  assert.equal(app.calls(), 2);
  assert.equal((await app.request('/publish', app.content)).body.replayed, true);
  assert.equal(app.calls(), 2);
});

test('failed outcome save stops unsubmitted accounts, releases the job and never sends it again', async t => {
  const app = await fixture(t);
  const originalSave = app.store.save;
  let saveCalls = 0;
  app.store.save = () => { if (++saveCalls > 1) throw locked(); originalSave(); };
  const failed = await app.request('/publish', app.content);
  assert.equal(failed.status, 503);
  assert.equal(app.calls(), 1);
  assert.deepEqual(app.store.data.history[0].results.map(result => result.status), ['success', 'failed']);
  assert.equal(app.store.data.history[0].results[1].code, 'STORAGE_ERROR');
  // While persistence is still broken, querying cannot claim that results were saved.
  assert.equal((await app.request('/publish', app.content)).status, 503);
  app.store.save = originalSave;
  const replay = await app.request('/publish', app.content);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.results.map(result => result.status), ['success', 'failed']);
  assert.equal(app.calls(), 1);
  const restored = createStore(app.directory);
  assert.deepEqual(restored.data.history[0].results.map(result => result.status), ['success', 'failed']);
});

test('atomic database save retries transient Windows rename locks and removes failed temporary files', t => {
  const directory = temporaryDirectory(t);
  let failures = 2;
  let attempts = 0;
  const delays = [];
  const store = createStore(directory, {
    fileSystem: { ...fs, renameSync(from, to) {
      attempts++;
      if (failures-- > 0) throw locked();
      fs.renameSync(from, to);
    } },
    sleepSync: delay => delays.push(delay),
  });
  store.data.drafts.push({ id: 'saved-before-failure', body: 'safe' });
  store.save();
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  const before = fs.readFileSync(path.join(directory, 'database.json'), 'utf8');
  failures = 100;
  store.data.drafts.push({ id: 'not-saved', body: 'not yet' });
  assert.throws(() => store.save(), { code: 'EPERM' });
  assert.equal(fs.readFileSync(path.join(directory, 'database.json'), 'utf8'), before);
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
});

test('a failed final completion save also releases the request without repeating successful accounts', async t => {
  const app = await fixture(t);
  const originalSave = app.store.save;
  let saveCalls = 0;
  app.store.save = () => { if (++saveCalls === 4) throw locked(); originalSave(); };
  const failed = await app.request('/publish', app.content);
  assert.equal(failed.status, 503);
  assert.equal(app.calls(), 2);
  const replay = await app.request('/publish', app.content);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.results.map(result => result.status), ['success', 'success']);
  assert.equal(app.calls(), 2);
  const restored = createStore(app.directory);
  assert.ok(restored.data.history[0].completedAt);
  assert.deepEqual(restored.data.history[0].results.map(result => result.status), ['success', 'success']);
});
