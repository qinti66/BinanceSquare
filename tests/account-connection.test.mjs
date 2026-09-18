import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAccountConnectionTester, classifyConnectionError } from '../server/connection-test.mjs';
import { createApiServer } from '../server/api.mjs';

const KEY = 'private-square-connection-test-key-0123456789';
const STATUS_URL = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi/image/imageStatus';
const json = (code, status = 200, extra = {}) => new Response(JSON.stringify({ code, ...extra }), { status, headers: { 'Content-Type': 'application/json' } });
const errorWith = (code, fields = {}) => Object.assign(new Error(`sensitive ${KEY}`), { code, ...fields });

async function fixture(t, fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-connection-test-'));
  const app = createApiServer({ dataDirectory: directory, fetchImpl, pause: async () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  async function request(route, body = {}, headers = {}) {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function account(name = '测试账号') {
    const response = await request('/api/accounts', { name, apiKey: KEY });
    assert.equal(response.status, 201);
    return response.body.account;
  }
  return { ...app, base, directory, request, account };
}

function assertSafe(result) {
  assert.ok(['reachable', 'error'].includes(result.status));
  assert.ok(['unverified', 'invalid', 'expired'].includes(result.keyStatus));
  assert.equal(Number.isFinite(Date.parse(result.checkedAt)), true);
  assert.equal(typeof result.elapsedMs, 'number');
  assert.ok(result.elapsedMs >= 0);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
}

test('connection tester only queries a fresh nonexistent ticket and never validates posting permission', async () => {
  const tickets = new Set();
  let calls = 0;
  const tester = createAccountConnectionTester({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, STATUS_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-Square-OpenAPI-Key'], KEY);
    assert.equal(options.headers.clienttype, 'binanceSkill');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body), ['fileTicket']);
    assert.match(body.fileTicket, /^[a-f0-9-]{36}$/);
    tickets.add(body.fileTicket);
    return json(calls === 1 ? '000000' : '220095', 200, { message: `sensitive ${KEY}`, data: { status: 1, secret: KEY } });
  } });
  for (let n = 0; n < 2; n++) {
    const result = await tester(KEY);
    assertSafe(result);
    assert.equal(result.status, 'reachable');
    assert.equal(result.keyStatus, 'unverified');
    assert.match(result.message, /尚未确认 API Key/);
    assert.equal(result.data, undefined);
  }
  assert.equal(calls, 2);
  assert.equal(tickets.size, 2);
});

test('only documented key errors report nonexistent or expired keys without echoing upstream text', async () => {
  for (const [code, keyStatus, httpStatus] of [['220003', 'invalid', 200], ['220004', 'expired', 200], ['220003', 'invalid', 400], ['220004', 'expired', 401], ['220003', 'invalid', 403]]) {
    const tester = createAccountConnectionTester({ fetchImpl: async () => json(code, httpStatus, { message: `sensitive ${KEY}` }) });
    const result = await tester(KEY);
    assertSafe(result);
    assert.equal(result.status, 'error');
    assert.equal(result.keyStatus, keyStatus);
    assert.equal(result.code, code);
  }
});

test('HTML, malformed and oversized envelopes cannot become a successful connection result or leak credentials', async () => {
  const bodies = ['<html>challenge</html>', '{', '{}', 'null', '[]', JSON.stringify({ code: KEY }), JSON.stringify({ code: { secret: KEY } }), JSON.stringify({ code: '000000', message: 'x'.repeat(70 * 1024) })];
  for (const body of bodies) {
    const result = await createAccountConnectionTester({ fetchImpl: async () => new Response(body) })(KEY);
    assertSafe(result);
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'INVALID_RESPONSE');
    assert.equal(result.keyStatus, 'unverified');
  }
  const numericKey = '12345678';
  const result = await createAccountConnectionTester({ fetchImpl: async () => json(`9${numericKey}0`) })(numericKey);
  assert.equal(result.code, 'INVALID_RESPONSE');
  assert.equal(JSON.stringify(result).includes(numericKey), false);
});

test('HTTP access blocks, rate limits, service errors, and redirects remain explicit failures', async () => {
  const titles = new Map([[403, '币安拒绝当前访问'], [451, '币安拒绝当前访问'], [429, '币安请求受到限制'], [418, '币安请求受到限制'], [500, '币安服务暂不可用'], [503, '币安服务暂不可用'], [401, '币安拒绝认证请求'], [400, '币安接口请求未成功'], [302, '币安接口发生重定向']]);
  for (const [status, title] of titles) {
    let calls = 0;
    const result = await createAccountConnectionTester({ fetchImpl: async (_url, options) => {
      calls++; assert.equal(options.redirect, 'manual');
      return new Response(`sensitive ${KEY}`, { status, headers: { Location: 'https://untrusted.example/' } });
    } })(KEY);
    assertSafe(result);
    assert.equal(result.status, 'error');
    assert.equal(result.keyStatus, 'unverified');
    assert.equal(result.httpStatus, status);
    assert.equal(result.title, title);
    assert.equal(calls, 1);
  }
});

test('nested Node and AggregateError failures distinguish network causes without leaking raw details', async () => {
  const cases = [
    [errorWith('ENOTFOUND'), 'DNS_ERROR'],
    [errorWith('EAI_AGAIN'), 'DNS_ERROR'],
    [errorWith('ETIMEDOUT'), 'CONNECTION_TIMEOUT'],
    [errorWith('UND_ERR_CONNECT_TIMEOUT'), 'CONNECTION_TIMEOUT'],
    [Object.assign(new Error(KEY), { name: 'TimeoutError' }), 'CONNECTION_TIMEOUT'],
    [errorWith('CERT_HAS_EXPIRED'), 'TLS_ERROR'],
    [errorWith('ERR_TLS_CERT_ALTNAME_INVALID'), 'TLS_ERROR'],
    [errorWith('ECONNREFUSED'), 'CONNECTION_REFUSED'],
    [errorWith('ECONNRESET'), 'CONNECTION_RESET'],
    [errorWith('ENETUNREACH', { address: '2001:db8::1' }), 'IPV6_UNREACHABLE'],
    [errorWith('EHOSTUNREACH', { address: '192.0.2.1' }), 'NETWORK_UNREACHABLE'],
    [new Error(`unexpected redirect ${KEY}`), 'REDIRECT_BLOCKED'],
    [new Error(KEY), 'CONNECTION_ERROR'],
  ];
  for (const [error, code] of cases) {
    const wrapped = new TypeError('fetch failed', { cause: new AggregateError([error], KEY) });
    const result = await createAccountConnectionTester({ fetchImpl: async () => { throw wrapped; } })(KEY);
    assertSafe(result);
    assert.equal(result.code, code);
    assert.equal(result.status, 'error');
    assert.equal(result.keyStatus, 'unverified');
    assert.equal(result.httpStatus, undefined);
  }
  const cyclic = errorWith('ECONNREFUSED'); cyclic.cause = cyclic;
  assert.equal(classifyConnectionError(cyclic).code, 'CONNECTION_REFUSED');
});

test('a timeout while reading the response is a connection failure, not API success', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error(KEY), { name: 'TimeoutError' })); } }));
  const result = await createAccountConnectionTester({ fetchImpl: async () => response })(KEY);
  assertSafe(result);
  assert.equal(result.code, 'CONNECTION_TIMEOUT');
});

test('account test reads its saved encrypted key and leaves database, history and media untouched', async t => {
  let calls = 0;
  const app = await fixture(t, async (url, options) => {
    calls++; assert.equal(url, STATUS_URL); assert.equal(options.headers['X-Square-OpenAPI-Key'], KEY);
    return json('220095');
  });
  const account = await app.account();
  const database = fs.readFileSync(path.join(app.directory, 'database.json'));
  const memory = JSON.stringify(app.store.data);
  const result = await app.request(`/api/accounts/${account.id}/test`);
  assert.equal(result.status, 200);
  assertSafe(result.body.test);
  assert.equal(result.body.test.status, 'reachable');
  assert.equal(calls, 1);
  assert.deepEqual(fs.readFileSync(path.join(app.directory, 'database.json')), database);
  assert.equal(JSON.stringify(app.store.data), memory);
  assert.deepEqual(app.store.data.history, []);
  assert.deepEqual(app.store.data.media, []);
  assert.equal(JSON.stringify(result).includes('ciphertext'), false);
});

test('account test rejects cross-origin requests and invalid or oversized bodies before any upstream call', async t => {
  const app = await fixture(t, async () => assert.fail('Rejected requests must not contact Binance'));
  const account = await app.account();
  const route = `/api/accounts/${account.id}/test`;
  assert.equal((await app.request('/api/accounts/missing/test')).status, 404);
  assert.equal((await app.request(route, {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.request(route, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(`${app.base}${route}`, { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    request.end('{}');
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await app.request(route, { apiKey: KEY })).status, 400);
  assert.equal((await app.request(route, { body: 'x'.repeat(2048) })).status, 413);
  assert.equal((await app.request(route, {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${app.base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
});

test('overlapping tests for the same account are rejected and the slot is released after completion', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const app = await fixture(t, async () => { calls++; entered(); await waiting; throw errorWith('ENOTFOUND'); });
  const account = await app.account();
  const route = `/api/accounts/${account.id}/test`;
  const first = app.request(route);
  try {
    await started;
    const duplicate = await app.request(route);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'ACCOUNT_TEST_RUNNING');
    assert.equal(calls, 1);
  } finally { release(); }
  assert.equal((await first).body.test.code, 'DNS_ERROR');
  assert.equal((await app.request(route)).body.test.code, 'DNS_ERROR');
  assert.equal(calls, 2);
});

test('connection tests cap parallel upstream requests at eight across different accounts', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const app = await fixture(t, async () => { calls++; if (calls === 8) entered(); await waiting; return json('220095'); });
  const accounts = [];
  for (let i = 0; i < 9; i++) accounts.push(await app.account(`账号 ${i}`));
  const requests = accounts.slice(0, 8).map(account => app.request(`/api/accounts/${account.id}/test`));
  try {
    await started;
    const limited = await app.request(`/api/accounts/${accounts[8].id}/test`);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'ACCOUNT_TEST_LIMIT');
    assert.equal(calls, 8);
  } finally { release(); }
  assert.ok((await Promise.all(requests)).every(result => result.body.test.status === 'reachable'));
  assert.equal((await app.request(`/api/accounts/${accounts[8].id}/test`)).body.test.status, 'reachable');
  assert.equal(calls, 9);
});

test('decryption failures do not reveal encrypted secrets or leave an account test slot occupied', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; return json('220095'); });
  const account = await app.account();
  const saved = app.store.data.accounts[0].secret;
  app.store.data.accounts[0].secret = { ...saved, tag: Buffer.alloc(16).toString('base64') };
  const result = await app.request(`/api/accounts/${account.id}/test`);
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes(saved.ciphertext), false);
  assert.equal(calls, 0);
  app.store.data.accounts[0].secret = saved;
  assert.equal((await app.request(`/api/accounts/${account.id}/test`)).body.test.status, 'reachable');
  assert.equal(calls, 1);
});

test('publishing retains uncertain/idempotent semantics while media connection failures gain actionable causes', async t => {
  let calls = 0;
  const app = await fixture(t, async () => { calls++; throw new TypeError('fetch failed', { cause: errorWith('ENOTFOUND') }); });
  const account = await app.account();
  const content = { requestId: randomUUID(), accountIds: [account.id], type: 'post', body: '用户明确确认的正文', mediaIds: [], demo: false };
  const first = await app.request('/api/publish', content);
  assert.equal(first.body.results[0].status, 'uncertain');
  assert.equal(first.body.results[0].code, 'DNS_ERROR');
  assert.match(first.body.results[0].error, /DNS/);
  assert.match(first.body.results[0].error, /发布结果未知/);
  assert.doesNotMatch(first.body.results[0].error, /重试/);
  assert.equal(JSON.stringify(first).includes(KEY), false);
  await app.request('/api/publish', content);
  assert.equal(calls, 1);
  const image = await app.request('/api/media', { name: 'cover.png', type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nEAAAAAASUVORK5CYII=' });
  assert.equal(image.status, 201);
  const second = await app.request('/api/publish', { ...content, requestId: randomUUID(), mediaIds: [image.body.media.id] });
  assert.equal(second.body.results[0].status, 'failed');
  assert.equal(second.body.results[0].code, 'DNS_ERROR');
  assert.match(second.body.results[0].error, /内容尚未提交/);
  assert.match(second.body.results[0].error, /账号管理中测试连接/);
  assert.equal(calls, 2);
});
