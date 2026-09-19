import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createProductionServer, readProductionConfig } from '../server/production.mjs';
import { createLoginAuth, SESSION_SECONDS } from '../server/auth.mjs';

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
  function request(route, { method = 'GET', body, rawBody, auth = true, host = '203.0.113.25:8080', origin, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody;
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

function login(f, { username = 'admin', password = PASSWORD, headers = {}, ...options } = {}) {
  return f.request('/login', {
    method: 'POST', auth: false, origin: 'http://203.0.113.25:8080',
    rawBody: new URLSearchParams({ username, password }).toString(),
    ...options, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  });
}
function sessionCookie(response) {
  assert.ok(response.headers['set-cookie']?.length, 'successful login must issue a cookie');
  return response.headers['set-cookie'][0].split(';', 1)[0];
}

test('new browser navigation reaches a usable login page while APIs and assets remain protected', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'HEAD']) {
    for (const headers of [{ Accept: 'text/html' }, { 'Sec-Fetch-Dest': 'document' }]) {
      const response = await f.request('/', { auth: false, method, headers });
      assert.equal(response.status, 303);
      assert.equal(response.headers.location, '/login');
      assert.equal(response.headers['www-authenticate'], undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  }
  const page = await f.request('/login', { auth: false, headers: { Accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.equal(page.headers['www-authenticate'], undefined);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.text, /name=["']username["']/);
  assert.match(page.text, /name=["']password["']/);
  assert.ok(!page.text.includes(PASSWORD), 'the login page must never contain the configured password');
  const head = await f.request('/login', { auth: false, method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, '');
  for (const route of ['/api/accounts', '/api/drafts', '/api/media/id', '/assets/app-a1B2c3D4.js']) {
    const response = await f.request(route, { auth: false, headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' } });
    assert.equal(response.status, 401, route);
    assert.equal(response.headers.location, undefined);
    assert.match(response.headers['content-type'], /^application\/json/);
  }
  const api = await f.request('/api/accounts', { auth: false, headers: { 'Sec-Fetch-Mode': 'cors' } });
  assert.equal(api.status, 401);
  assert.equal(api.json.code, 'AUTH_REQUIRED');
  assert.equal(api.json.loginUrl, '/login');
  assert.equal(api.headers['www-authenticate'], undefined);
  const script = await f.request('/api/accounts', { auth: false });
  assert.match(script.headers['www-authenticate'], /^Basic/);
});

test('form login issues independent HTTP sessions that share persisted drafts and authenticated media', async t => {
  const f = await fixture(t);
  const first = await login(f);
  assert.equal(first.status, 303); assert.equal(first.headers.location, '/');
  assert.equal(first.headers['www-authenticate'], undefined);
  assert.equal(first.headers['cache-control'], 'no-store');
  const setCookie = first.headers['set-cookie'][0];
  for (const attribute of [/;\s*HttpOnly(?:;|$)/i, /;\s*SameSite=Lax(?:;|$)/i, /;\s*Path=\/(?:;|$)/i, /;\s*Max-Age=43200(?:;|$)/i])
    assert.match(setCookie, attribute);
  assert.doesNotMatch(setCookie, /;\s*(?:Secure|Domain=)/i);
  assert.ok(!setCookie.includes(PASSWORD));
  const firstCookie = sessionCookie(first);
  const second = await login(f);
  assert.equal(second.status, 303);
  const secondCookie = sessionCookie(second);
  assert.notEqual(firstCookie, secondCookie, 'each browser must get its own session');
  const firstHeaders = { Cookie: firstCookie };
  const secondHeaders = { Cookie: secondCookie };
  const draft = { type: 'post', title: '跨浏览器草稿', body: '两个浏览器共享服务器保存的内容。', updatedAt: '2026-09-19T00:00:00.000Z' };
  const saved = await f.request('/api/drafts/shared-login-draft', {
    method: 'PUT', body: draft, auth: false, origin: 'http://203.0.113.25:8080', headers: firstHeaders,
  });
  assert.equal(saved.status, 200);
  const listed = await f.request('/api/drafts', { auth: false, headers: secondHeaders });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.drafts.find(d => d.id === 'shared-login-draft').body, draft.body);
  const uploaded = await f.request('/api/media', post({ name: 'session.png', type: 'image/png', data: PNG }, { auth: false, headers: secondHeaders }));
  assert.equal(uploaded.status, 201);
  const media = await f.request(uploaded.json.media.url, { auth: false, headers: firstHeaders });
  assert.equal(media.status, 200); assert.deepEqual(media.buffer, Buffer.from(PNG, 'base64'));
  assert.equal((await f.request(uploaded.json.media.url, { auth: false })).status, 401);
  for (const headers of [firstHeaders, secondHeaders]) {
    assert.equal((await f.request('/', { auth: false, headers })).status, 200);
    assert.equal((await f.request('/assets/app-a1B2c3D4.js', { auth: false, headers })).status, 200);
    assert.equal((await f.request('/api/accounts', { auth: false, headers })).status, 200);
  }
});

test('login rejects invalid credentials, cross-site forms and unsupported or oversized request bodies', async t => {
  const f = await fixture(t);
  const failures = [await login(f, { password: 'incorrect-login-password' }), await login(f, { username: 'unknown-login-user' })];
  for (const response of failures) {
    assert.equal(response.status, 401);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.equal(response.headers['www-authenticate'], undefined);
    assert.match(response.text, /用户名|密码|登录/);
    assert.ok(!response.text.includes(PASSWORD));
    assert.ok(!response.text.includes('incorrect-login-password'));
    assert.ok(!response.text.includes('unknown-login-user'));
  }
  assert.equal(failures[0].text, failures[1].text, 'unknown user and incorrect password must have the same generic response');
  for (const origin of [undefined, 'https://evil.example', 'http://203.0.113.25:8081'])
    assert.equal((await login(f, { origin })).status, 403);
  for (const site of ['cross-site', 'same-site'])
    assert.equal((await login(f, { headers: { 'Sec-Fetch-Site': site } })).status, 403);
  assert.equal((await login(f, { headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await login(f, { rawBody: 'password=' + 'x'.repeat(128 * 1024) })).status, 413);
  assert.equal((await f.request('/api/accounts', { auth: false })).status, 401);
});

test('session cookies cannot bypass origin checks, another origin, tampering or a server restart', async t => {
  const f = await fixture(t);
  const cookie = sessionCookie(await login(f));
  const headers = { Cookie: cookie };
  const account = { name: 'Cookie account', apiKey: 'fake-cookie-key-only-for-tests' };
  for (const origin of [undefined, 'https://evil.example', 'http://203.0.113.25:8081'])
    assert.equal((await f.request('/api/accounts', { method: 'POST', body: account, auth: false, origin, headers })).status, 403);
  for (const site of ['cross-site', 'same-site'])
    assert.equal((await f.request('/api/accounts', post(account, { auth: false, headers: { ...headers, 'Sec-Fetch-Site': site } }))).status, 403);
  assert.equal((await f.request('/api/accounts', { auth: false, headers, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/accounts', { auth: false, headers, host: '203.0.113.26:8080' })).status, 401);
  assert.equal((await f.request('/api/accounts', { auth: false, headers, host: '203.0.113.25:8081' })).status, 401);
  for (const forged of [cookie + 'invalid', cookie.replace(/=.*/, '=forged-session-token'), 'unrelated=anything'])
    assert.equal((await f.request('/api/accounts', { auth: false, headers: { Cookie: forged } })).status, 401);
  assert.equal((await f.request('/api/accounts', post(account, { auth: false, headers }))).status, 201);
  await f.restart();
  assert.equal((await f.request('/api/accounts', { auth: false, headers })).status, 401);
  assert.equal((await f.request('/api/accounts')).status, 200, 'existing Basic clients remain compatible after restart');
  const renewed = sessionCookie(await login(f));
  assert.notEqual(renewed, cookie);
  assert.equal((await f.request('/api/accounts', { auth: false, headers: { Cookie: renewed } })).json.accounts[0].name, account.name);
});

test('HTTPS proxy login enforces PUBLIC_ORIGIN and sets Secure without trusting forwarded headers', async t => {
  const f = await fixture(t, { publicOrigin: 'https://square.example.com' });
  const host = 'square.example.com';
  const origin = 'https://square.example.com';
  assert.equal((await f.request('/login', { auth: false })).status, 403);
  assert.equal((await login(f)).status, 403);
  assert.equal((await login(f, { host, origin: 'http://square.example.com', headers: { 'X-Forwarded-Proto': 'https' } })).status, 403);
  assert.equal((await login(f, { origin, headers: { 'X-Forwarded-Host': host } })).status, 403);
  const response = await login(f, { host, origin });
  assert.equal(response.status, 303);
  assert.match(response.headers['set-cookie'][0], /;\s*Secure(?:;|$)/i);
  const headers = { Cookie: sessionCookie(response) };
  assert.equal((await f.request('/api/accounts', { auth: false, host, headers })).status, 200);
  assert.equal((await f.request('/api/accounts', post({ name: 'Proxy cookie', apiKey: 'fake-proxy-cookie-key' }, { auth: false, host, origin, headers }))).status, 201);
});
test('signed browser sessions expire after twelve hours even when a client retains the cookie', t => {
  let now = Date.UTC(2026, 8, 19);
  t.mock.method(Date, 'now', () => now);
  const auth = createLoginAuth({ adminUser: 'admin', adminPassword: PASSWORD, secureCookies: false });
  const origin = 'http://203.0.113.25:8080';
  const cookie = auth.sessionCookie(origin).split(';', 1)[0];
  const request = { headers: { cookie } };
  assert.equal(auth.authenticated(request, origin), true);
  now += SESSION_SECONDS * 1000 - 1;
  assert.equal(auth.authenticated(request, origin), true);
  now += 1;
  assert.equal(auth.authenticated(request, origin), false);
  assert.equal(auth.authenticated({ headers: { authorization: AUTH } }, origin), true, 'session expiry does not disable Basic authentication');
});