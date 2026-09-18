import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApiServer } from '../server/api.mjs';
import { createStore } from '../server/store.mjs';

const KEY_A = 'secret-square-key-account-a-0123456789';
const KEY_B = 'secret-square-key-account-b-9876543210';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nEAAAAAASUVORK5CYII=';
const success = data => new Response(JSON.stringify({ code: '000000', data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, fetchImpl = async () => success({ id: '123456' })) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-api-test-'));
  let { server, store } = createApiServer({ dataDirectory: directory, fetchImpl, pause: async () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  async function request(route, method = 'GET', body, headers = {}) {
    const response = await fetch(`${base}${route}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function account(name = '主账号', apiKey = KEY_A) { const response = await request('/api/accounts', 'POST', { name, apiKey }); assert.equal(response.status, 201); return response.body.account; }
  async function media(type = 'image/png', data = PNG, name = 'chart.png') { const response = await request('/api/media', 'POST', { name, type, data }); assert.equal(response.status, 201); return response.body.media; }
  async function restart() {

    await new Promise(resolve => server.close(resolve));
    ({ server, store } = createApiServer({ dataDirectory: directory, fetchImpl, pause: async () => {} }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    return store;
  }
  return { directory, store, request, account, media, base, restart };
}
const post = accountIds => ({ requestId: randomUUID(), accountIds, type: 'post', body: '本周观察 #比特币 $BTC 📈', mediaIds: [], demo: false });

test('account keys are encrypted, public responses never reveal keys, edits are local', async t => {
  const app = await fixture(t);
  const account = await app.account();
  assert.equal(account.keyConfigured, true);
  assert.equal(account.secret, undefined);
  assert.equal(JSON.stringify(account).includes(KEY_A), false);
  const database = fs.readFileSync(path.join(app.directory, 'database.json'), 'utf8');
  assert.equal(database.includes(KEY_A), false);
  assert.equal(app.store.decrypt(app.store.data.accounts[0].secret), KEY_A);
  const update = await app.request(`/api/accounts/${account.id}`, 'PATCH', { name: '仅本地展示', apiKey: '' });
  assert.equal(update.body.account.name, '仅本地展示');
  assert.equal(app.store.decrypt(app.store.data.accounts[0].secret), KEY_A);
  const changedKey = await app.request(`/api/accounts/${account.id}`, 'PATCH', { apiKey: KEY_B });
  assert.equal(JSON.stringify(changedKey).includes(KEY_B), false);
  assert.equal(app.store.decrypt(app.store.data.accounts[0].secret), KEY_B);
  const list = await app.request('/api/accounts');
  assert.equal(JSON.stringify(list).includes('ciphertext'), false);
  assert.equal((await app.request(`/api/accounts/${account.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await app.request('/api/accounts')).body.accounts, []);
});

test('AES GCM detects tampering and refuses missing master key with saved accounts', async t => {
  const app = await fixture(t);
  await app.account();
  const secret = { ...app.store.data.accounts[0].secret, tag: Buffer.alloc(16).toString('base64') };
  assert.throws(() => app.store.decrypt(secret));
  fs.unlinkSync(path.join(app.directory, 'master.key'));
  assert.throws(() => createStore(app.directory), /encryption key is missing/);
});

test('drafts persist, overwrite by id, delete, and strip unexpected top-level secrets', async t => {
  const app = await fixture(t);
  const input = { type: 'article', title: '草稿', body: '还没写完', html: '<p>还没写完</p>', selectedAccounts: ['demo-main'], demo: true, apiKey: KEY_A, updatedAt: '2026-09-18T01:00:00.000Z' };
  assert.equal((await app.request('/api/drafts/draft-a', 'PUT', input)).status, 200);
  const restored = createStore(app.directory);
  assert.equal(restored.data.drafts[0].body, '还没写完');
  assert.equal(restored.data.drafts[0].apiKey, undefined);
  await app.request('/api/drafts/draft-a', 'PUT', { ...input, body: '写完了', updatedAt: '2026-09-18T01:00:01.000Z' });
  const list = await app.request('/api/drafts');
  assert.equal(list.body.drafts.length, 1);
  assert.equal(list.body.drafts[0].body, '写完了');
  await app.request('/api/drafts/draft-a', 'DELETE');
  assert.deepEqual((await app.request('/api/drafts')).body.drafts, []);
});

test('multi-account publishing preserves partial failures and never retries identical request', async t => {
  let calls = 0;
  const app = await fixture(t, async (url, options) => {
    calls++;
    assert.match(url, /v1\/public\/pgc\/openApi\/content\/add$/);
    assert.deepEqual(JSON.parse(options.body), { contentType: 1, bodyTextOnly: '本周观察 #比特币 $BTC 📈' });
    if (options.headers['X-Square-OpenAPI-Key'] === KEY_B) return new Response(JSON.stringify({ code: '220004', message: 'API key expired' }), { status: 200 });
    return success({ id: '98765' });
  });
  const first = await app.account(); const second = await app.account('第二账号', KEY_B);
  const content = post([first.id, second.id]);
  const publish = await app.request('/api/publish', 'POST', content);
  assert.equal(publish.status, 200);
  assert.deepEqual(publish.body.results.map(item => item.status), ['success', 'failed']);
  assert.equal(publish.body.results[0].postUrl, 'https://www.binance.com/square/post/98765');
  assert.equal(publish.body.results[1].code, '220004');
  const replay = await app.request('/api/publish', 'POST', content);
  assert.equal(replay.body.replayed, true);
  assert.equal(calls, 2);
  const conflict = await app.request('/api/publish', 'POST', { ...content, body: '不同内容' });
  assert.equal(conflict.status, 409);
  assert.equal(calls, 2);
  const history = (await app.request('/api/history')).body.history;
  assert.equal(history.length, 1);
  assert.equal(history[0].fingerprint, undefined);
  assert.equal(JSON.stringify(history).includes(KEY_A), false);
});

test('concurrent replay returns pending without sending a second upstream call', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const app = await fixture(t, async () => { calls++; entered(); await waiting; return success({ id: '123' }); });
  const account = await app.account(); const content = post([account.id]);
  const first = app.request('/api/publish', 'POST', content);
  await enteredPromise;
  const replay = await app.request('/api/publish', 'POST', content);
  assert.equal(replay.status, 202);
  assert.equal(replay.body.results[0].status, 'pending');
  release();
  assert.equal((await first).body.results[0].status, 'success');
  assert.equal(calls, 1);
});

test('504 and network failures after submission are uncertain and stay idempotent', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; if (calls === 1) return new Response('Gateway Timeout', { status: 504 }); throw new Error('network with sensitive details'); });
  const account = await app.account();
  const content = post([account.id]);
  const result = await app.request('/api/publish', 'POST', content);
  assert.equal(result.body.results[0].status, 'uncertain');
  assert.equal(result.body.results[0].code, 'HTTP_504');
  await app.request('/api/publish', 'POST', content);
  assert.equal(calls, 1);
  const network = await app.request('/api/publish', 'POST', post([account.id]));
  assert.equal(network.body.results[0].status, 'uncertain');
  assert.equal(JSON.stringify(network).includes('sensitive details'), false);
});

test('interrupted ledger entries recover as uncertain without re-sending', async t => {
  const app = await fixture(t);
  app.store.data.history.push({ id: 'interrupted', requestId: 'interrupted', results: [{ accountId: 'a', status: 'pending' }] });
  app.store.save();
  const restored = createStore(app.directory);
  assert.equal(restored.data.history[0].results[0].status, 'uncertain');
});

test('demo is strictly simulated with a visible marker and never contacts upstream', async t => {
  const app = await fixture(t, async () => { assert.fail('Demo must never make an upstream request'); });
  const content = { ...post(['demo-main', 'demo-market']), demo: true };
  const result = await app.request('/api/publish', 'POST', content);
  assert.equal(result.body.demo, true);
  assert.equal(result.body.results.length, 2);
  assert.ok(result.body.results.every(item => item.demo && item.status === 'success' && item.postUrl === null));
  assert.equal((await app.request('/api/publish', 'POST', { ...content, requestId: randomUUID(), demo: 'true' })).status, 400);
  assert.equal((await app.request('/api/publish', 'POST', { ...content, requestId: randomUUID(), demo: false })).status, 400);
});

test('media validates signatures, rejects unsupported files, and streams byte ranges', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/media', 'POST', { name: 'fake.png', type: 'image/png', data: Buffer.from('<script>bad()</script>').toString('base64') })).status, 415);
  assert.equal((await app.request('/api/media', 'POST', { name: 'image.svg', type: 'image/svg+xml', data: PNG })).status, 415);
  const media = await app.media();
  const response = await fetch(`${app.base}${media.url}`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-length'), '8');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(PNG, 'base64').subarray(0, 8));
});

test('origin, host, content type, malformed JSON, and huge bodies are rejected safely', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/accounts', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(`${app.base}/api/accounts`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await app.request('/api/accounts', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(`${app.base}/api/accounts`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${app.base}/api/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'invalid{' })).status, 400);
  assert.equal((await app.request('/api/accounts', 'POST', { name: 'X', apiKey: 'a'.repeat(2 * 1024 * 1024) })).status, 413);
});

test('image and article upload use official media processing and keep keys off presigned PUT', async t => {
  const calls = [];
  const app = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/image/presignedUrl')) return success({ presignedUrl: 'https://uploads.example.com/signed', fileTicket: 'ticket-1' });
    if (options.method === 'PUT') { assert.equal(options.headers['X-Square-OpenAPI-Key'], undefined); return new Response('', { status: 200 }); }
    if (url.endsWith('/image/imageStatus')) return success({ status: 1, imageUrl: 'https://cdn.example.com/chart.png' });
    return success({ id: '900' });
  });
  const account = await app.account(); const image = await app.media();
  const result = await app.request('/api/publish', 'POST', { ...post([account.id]), type: 'article', title: '市场观察', mediaIds: [image.id] });
  assert.equal(result.body.results[0].status, 'success');
  const sent = JSON.parse(calls.at(-1).options.body);
  assert.deepEqual(sent, { contentType: 2, bodyTextOnly: '本周观察 #比特币 $BTC 📈', title: '市场观察', cover: 'https://cdn.example.com/chart.png' });
  assert.equal(sent.imageList, undefined);
});

test('video upload uses ticket, cover, duration; missing cover never submits', async t => {
  const calls = [];
  const app = await fixture(t, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/video/preSign')) return success({ presignedUrl: 'https://uploads.example.com/video', fileTicket: 'video-ticket' });
    if (url.endsWith('/image/presignedUrl')) return success({ presignedUrl: 'https://uploads.example.com/cover', fileTicket: 'cover-ticket' });
    if (options.method === 'PUT') return new Response('', { status: 200 });
    if (url.endsWith('/image/imageStatus')) return success({ status: 1, imageUrl: 'https://cdn.example.com/cover.png' });
    return success({ id: '901' });
  });
  const account = await app.account(); const cover = await app.media();
  const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]).toString('base64');
  const video = await app.media('video/mp4', mp4, 'video.mp4');
  const content = { ...post([account.id]), type: 'video', mediaIds: [video.id], duration: 7.5 };
  assert.equal((await app.request('/api/publish', 'POST', content)).status, 400);
  assert.equal(calls.length, 0);
  const result = await app.request('/api/publish', 'POST', { ...content, coverMediaId: cover.id });
  assert.equal(result.body.results[0].status, 'success');
  const sent = JSON.parse(calls.at(-1).options.body);
  assert.equal(sent.contentType, 3);
  assert.equal(sent.fileTicket, 'video-ticket');
  assert.equal(sent.videoTimeSeconds, 7.5);
  assert.equal(sent.cover, 'https://cdn.example.com/cover.png');
  assert.equal(sent.isPublish, true);
});

test('unsafe presigned URL and leaked upstream secret are blocked/redacted', async t => {
  let calls = 0;
  const app = await fixture(t, async (url) => {
    calls++;
    if (url.endsWith('/image/presignedUrl')) return success({ presignedUrl: 'http://127.0.0.1:9999/secret', fileTicket: 'ticket-1' });
    return new Response(JSON.stringify({ code: '220003', message: `bad key ${KEY_A}` }));
  });
  const account = await app.account(); const image = await app.media();
  const mediaResult = await app.request('/api/publish', 'POST', { ...post([account.id]), mediaIds: [image.id] });
  assert.equal(mediaResult.body.results[0].status, 'failed');
  assert.match(mediaResult.body.results[0].error, /不安全/);
  assert.equal(calls, 1);
  const textResult = await app.request('/api/publish', 'POST', post([account.id]));
  assert.equal(textResult.body.results[0].status, 'failed');
  assert.equal(JSON.stringify(textResult).includes(KEY_A), false);
  assert.equal(fs.readFileSync(path.join(app.directory, 'database.json'), 'utf8').includes(KEY_A), false);
});



test('draft versions reject delayed overwrites and preserve every composer field across restart', async t => {
  const app = await fixture(t);
  const account = await app.account();
  const beforeKey = fs.readFileSync(path.join(app.directory, 'master.key'));
  const first = { type: 'post', title: '旧标题', body: '旧正文', html: '<p>旧正文</p>', tags: ['BTC'], chart: { symbol: 'BTCUSDT', interval: '4h' }, media: [{ id: 'media-example', url: '/api/media/media-example', coverMediaId: 'cover-example', duration: 7.5 }], selectedAccounts: [account.id], demo: false, updatedAt: '2026-09-18T10:00:00.000Z' };
  assert.equal((await app.request('/api/drafts/versioned', 'PUT', first)).status, 200);
  const second = { ...first, title: '新标题', body: '最新正文', updatedAt: '2026-09-18T10:00:01.000Z' };
  assert.equal((await app.request('/api/drafts/versioned', 'PUT', second)).status, 200);
  const stale = await app.request('/api/drafts/versioned', 'PUT', first);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'DRAFT_STALE');
  assert.equal((await app.request('/api/drafts/versioned', 'PUT', second)).body.replayed, true);
  assert.equal((await app.request('/api/drafts/versioned', 'PUT', { ...second, body: '同时间不同内容' })).body.code, 'DRAFT_VERSION_CONFLICT');
  const restored = await app.restart();
  assert.deepEqual(fs.readFileSync(path.join(app.directory, 'master.key')), beforeKey);
  assert.equal(restored.decrypt(restored.data.accounts[0].secret), KEY_A);
  assert.equal((await app.request('/api/accounts')).body.accounts[0].id, account.id);
  const saved = (await app.request('/api/drafts')).body.drafts[0];
  for (const field of Object.keys(second)) assert.deepEqual(saved[field], second[field]);
  assert.ok(saved.savedAt);
  assert.equal((await app.request('/api/drafts/versioned', 'PUT', first)).body.code, 'DRAFT_STALE');
});

test('delete wins over an in-flight PUT and its tombstone survives a restart', async t => {
  const app = await fixture(t);
  const draft = { type: 'post', title: '待删除', body: '旧保存请求', updatedAt: '2026-09-18T10:00:00.000Z' };
  await app.request('/api/drafts/delete-race', 'PUT', draft);
  const json = JSON.stringify({ ...draft, body: '请求还在传输', updatedAt: '2026-09-18T10:00:01.000Z' });
  let slowRequest;
  const responsePromise = new Promise((resolve, reject) => {
    slowRequest = http.request(`${app.base}/api/drafts/delete-race`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }).on('error', reject);
    slowRequest.write(json.slice(0, 8));
  });
  assert.equal((await app.request('/api/drafts/delete-race', 'DELETE')).status, 200);
  slowRequest.end(json.slice(8));
  const result = await responsePromise;
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'DRAFT_DELETED');
  assert.deepEqual((await app.request('/api/drafts')).body.drafts, []);
  await app.restart();
  assert.equal((await app.request('/api/drafts/delete-race', 'PUT', draft)).body.code, 'DRAFT_DELETED');
  assert.equal((await app.request('/api/drafts/new-id', 'PUT', draft)).status, 200);
});

test('localhost 4173 proxy origins are accepted while unrelated local origins are rejected', async t => {
  const app = await fixture(t);
  for (const origin of ['http://127.0.0.1:4173', 'http://localhost:4173']) {
    const result = await app.request('/api/drafts/proxy-test', 'PUT', { type: 'post', body: '代理保存', updatedAt: '2026-09-18T10:00:00.000Z' }, { Origin: origin, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(result.status, 200);
  }
  assert.equal((await app.request('/api/accounts', 'GET', undefined, { Origin: 'http://localhost:9999' })).status, 403);
});

