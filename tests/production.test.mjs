import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createProductionServer, readProductionConfig } from '../server/production.mjs';

const PASSWORD = 'test-only-admin-password-12345';
const AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nEAAAAAASUVORK5CYII=';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const success = () => new Response(JSON.stringify({ code: '000000', data: { id: '12345' } }), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-production-test-'));
  const clientDirectory = path.join(directory, 'client');
  const dataDirectory = path.join(directory, 'data');
  fs.mkdirSync(path.join(clientDirectory, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(clientDirectory, 'index.html'), '<!doctype html><title>Square Studio</title>');
  fs.writeFileSync(path.join(clientDirectory, 'assets', 'app-a1B2c3D4.js'), 'console.log("built-app")');
  fs.writeFileSync(path.join(clientDirectory, '.env'), 'private-environment');
  fs.writeFileSync(path.join(clientDirectory, 'database.json'), 'private-database');
  fs.writeFileSync(path.join(directory, 'private.txt'), 'private-outside');
  const logs = [];
  const settings = { clientDirectory, dataDirectory, adminUser: 'admin', adminPassword: PASSWORD,
    fetchImpl: async () => { throw new Error('No real upstream is allowed in these tests.'); },
    pause: async () => {}, logger: { info: message => logs.push(message), error: message => logs.push(message) }, ...options };
  let app = createProductionServer(settings);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  function request(route, { method = 'GET', body, auth = true, host = '203.0.113.25:8080', origin, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const requestHeaders = { Host: host, Connection: 'close', ...(auth ? { Authorization: AUTH } : {}),
        ...(origin === undefined ? {} : { Origin: origin }),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers };
      const req = http.request({ hostname: '127.0.0.1', port: app.server.address().port, path: route, method, headers: requestHeaders }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks); const text = buffer.toString(); let json;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json, buffer });
        });
      });
      req.on('error', reject); req.end(payload);
    });
  }
  async function restart() {
    await app.shutdown(); app = createProductionServer(settings);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  }
  t.after(async () => {
    await app.shutdown();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('square-production-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { request, restart, get app() { return app; }, settings, directory, clientDirectory, dataDirectory, logs };
}
const post = (body, extras = {}) => ({ method: 'POST', body, origin: 'http://203.0.113.25:8080', ...extras });

test('production rejects missing or weak credentials before touching data and validates deployment config', () => {
  assert.throws(() => createProductionServer(), /ADMIN_PASSWORD/);
  assert.throws(() => createProductionServer({ adminPassword: 'short' }), /ADMIN_PASSWORD/);
  assert.throws(() => createProductionServer({ adminPassword: PASSWORD, adminUser: 'a:b' }), /ADMIN_USER/);
  for (const value of ['http://example.com', 'https://example.com/', 'https://user:pass@example.com', 'https://example.com/app'])
    assert.throws(() => createProductionServer({ adminPassword: PASSWORD, publicOrigin: value }), /PUBLIC_ORIGIN/);
  assert.equal(readProductionConfig({ ADMIN_PASSWORD: PASSWORD }).port, 8081);
  assert.equal(readProductionConfig({ ADMIN_PASSWORD: PASSWORD }).host, '0.0.0.0');
  assert.throws(() => readProductionConfig({ PORT: '65536' }), /PORT/);
  assert.throws(() => readProductionConfig({ HOST: 'bad/host' }), /HOST/);
  assert.throws(() => readProductionConfig({ HOST: 'localhost:8080' }), /HOST/);
});

test('anonymous health identifies the process while every page and API requires correct Basic credentials', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/healthz', { auth: false })).json, { ok: true, service: 'square-studio', pid: process.pid });
  assert.equal((await f.request('/healthz', { auth: false, method: 'HEAD' })).text, '');
  for (const route of ['/', '/assets/app-a1B2c3D4.js', '/api/health', '/api/accounts', '/api/drafts', '/api/history', '/api/media/id']) {
    const result = await f.request(route, { auth: false });
    assert.equal(result.status, 401, route);
    assert.match(result.headers['www-authenticate'], /^Basic/);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  for (const authorization of ['Basic d3Jvbmc6cGFzc3dvcmQ=', 'Basic !!!!', 'Bearer token', `${AUTH} junk`])
    assert.equal((await f.request('/api/accounts', { headers: { Authorization: authorization } })).status, 401);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/api/health')).json.localOnly, false);
});

test('real IP and IPv6 Hosts work; invalid Hosts and cross-site or missing-origin writes are blocked', async t => {
  const f = await fixture(t);
  for (const host of ['203.0.113.25:8080', '10.12.1.2:9999', '[2001:db8::1]:8080', 'square.example.com'])
    assert.equal((await f.request('/api/accounts', { host })).status, 200, host);
  for (const host of ['bad_host:8080', 'user@evil.example', 'evil.example/path', '999.999.999.999', 'square.example:70000'])
    assert.equal((await f.request('/api/accounts', { host })).status, 400, host);
  const body = { name: 'Server account', apiKey: 'fake-square-key-for-tests' };
  for (const origin of [undefined, 'https://evil.example', 'http://203.0.113.25:8081'])
    assert.equal((await f.request('/api/accounts', { method: 'POST', body, origin })).status, 403);
  for (const site of ['cross-site', 'same-site'])
    assert.equal((await f.request('/api/accounts', post(body, { headers: { 'Sec-Fetch-Site': site } }))).status, 403);
  assert.equal((await f.request('/api/accounts', post(body))).status, 201);
  assert.equal((await f.request('/api/accounts')).json.accounts.length, 1);
  assert.equal((await f.request('/api/accounts', { origin: 'https://evil.example' })).status, 403);
});

test('explicit HTTPS reverse-proxy origin is enforced without trusting forwarded headers', async t => {
  const f = await fixture(t, { publicOrigin: 'https://square.example.com' });
  const host = 'square.example.com';
  assert.equal((await f.request('/', { host })).status, 200);
  assert.equal((await f.request('/')).status, 403);
  const body = { name: 'Proxy account', apiKey: 'fake-square-key-for-proxy' };
  assert.equal((await f.request('/api/accounts', post(body, { host, origin: 'https://square.example.com' }))).status, 201);
  assert.equal((await f.request('/api/accounts', post(body, { host, headers: { 'X-Forwarded-Host': '203.0.113.25:8080', 'X-Forwarded-Proto': 'http' } }))).status, 403);
});

test('static responses support MIME, HEAD, cache and SPA fallback without exposing source or private files', async t => {
  const f = await fixture(t);
  assert.throws(() => createProductionServer({ ...f.settings, dataDirectory: path.join(f.clientDirectory, 'database-files') }), /DATA_DIR/);
  const asset = await f.request('/assets/app-a1B2c3D4.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /^text\/javascript/);
  assert.match(asset.headers['cache-control'], /immutable/);
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  const head = await f.request('/assets/app-a1B2c3D4.js', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, '');
  assert.equal(+head.headers['content-length'], asset.buffer.length);
  assert.equal((await f.request('/assets/app-a1B2c3D4.js', { headers: { 'If-None-Match': asset.headers.etag } })).status, 304);
  const route = await f.request('/drafts/example', { headers: { Accept: 'text/html' } });
  assert.equal(route.status, 200); assert.match(route.text, /Square Studio/);
  assert.equal((await f.request('/assets/missing.js', { headers: { Accept: 'text/html' } })).status, 404);
  for (const route of ['/.env', '/%2eenv', '/.data/master.key', '/%2e%2e/private.txt', '/../private.txt', '/assets/../.env', '/assets/%2e%2e/.env', '/assets%5c..%5c.env', '/.git/config', '/package.json', '/database.json', '/assets/app.js.map'])
    assert.equal((await f.request(route, { headers: { Accept: 'text/html' } })).status, 403, route);
  assert.equal((await f.request('/server/api.mjs')).status, 403);
  assert.equal((await f.request('/bad%zz')).status, 400);
  assert.equal((await f.request('/src/App.jsx')).status, 404);
  assert.equal((await f.request('/', { method: 'POST', origin: 'http://203.0.113.25:8080' })).status, 405);
  const outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
  // Directory junctions on Windows exercise the same lstat protection as Linux symlinks.
  fs.symlinkSync(outside, path.join(f.clientDirectory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.request('/linked/secret.txt')).status, 403);
  assert.equal((await f.request('/linked/missing', { headers: { Accept: 'text/html' } })).status, 403);
});

test('uploaded media remains authenticated, supports HEAD and byte ranges, and never reveals the data directory', async t => {
  const f = await fixture(t);
  const uploaded = await f.request('/api/media', post({ name: 'test.png', type: 'image/png', data: PNG }));
  assert.equal(uploaded.status, 201);
  const url = uploaded.json.media.url;
  assert.equal((await f.request(url, { auth: false })).status, 401);
  const image = await f.request(url); assert.equal(image.status, 200);
  assert.deepEqual(image.buffer, Buffer.from(PNG, 'base64'));
  const head = await f.request(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, ''); assert.equal(+head.headers['content-length'], image.buffer.length);
  const range = await f.request(url, { headers: { Range: 'bytes=0-7' } });
  assert.equal(range.status, 206); assert.equal(range.buffer.length, 8);
  assert.equal((await f.request('/data/master.key')).status, 403);
  assert.equal((await f.request('/data/database.json')).status, 403);
});

test('graceful shutdown waits for an in-flight publication, persists it, and same requestId never resends after restart', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; entered(); await waiting; return success(); } });
  const account = (await f.request('/api/accounts', post({ name: 'Publish', apiKey: 'fake-square-key-for-publish' }))).json.account;
  const content = { requestId: 'production-graceful-test', accountIds: [account.id], type: 'post', body: 'Test publication', mediaIds: [], demo: false };
  const publication = f.request('/api/publish', post(content));
  await started;
  let stopped = false;
  const stopping = f.app.shutdown().then(result => { stopped = true; return result; });
  await sleep(30); assert.equal(stopped, false);
  release();
  assert.equal((await publication).json.results[0].status, 'success');
  assert.deepEqual(await stopping, { timedOut: false });
  assert.ok(f.logs.some(message => message.includes('completed')));
  await f.restart();
  const replay = await f.request('/api/publish', post(content));
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.results[0].status, 'success'); assert.equal(calls, 1);
});

test('shutdown deadline is bounded and explicitly reports uncertain in-flight publications', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { shutdownTimeoutMs: 35, fetchImpl: async () => { entered(); await waiting; return success(); } });
  const account = (await f.request('/api/accounts', post({ name: 'Deadline', apiKey: 'fake-square-key-for-deadline' }))).json.account;
  const content = { requestId: 'production-deadline-test', accountIds: [account.id], type: 'post', body: 'Test publication', mediaIds: [], demo: false };
  const publication = f.request('/api/publish', post(content)).catch(error => error);
  await started;
  assert.deepEqual(await f.app.shutdown(), { timedOut: true });
  assert.ok(f.logs.some(message => message.includes('uncertain')));
  release(); await publication;
  // Let the injected upstream finish writing before fixture removal; a real CLI
  // exits on the deadline and createStore recovers the disk ledger as uncertain.
  await sleep(30);
});
