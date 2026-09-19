import { chromium, expect } from '@playwright/test';
import { createProductionServer } from '../server/production.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const out = path.resolve('artifacts/account-connection-qa');
await fs.mkdir(out, { recursive: true });
const password = 'qa-only-account-connection-password';
const fakeKeys = ['FAKE_QA_CONNECTION_KEY_0123456789', 'FAKE_QA_REPLACEMENT_KEY_9876543210'];
const upstream = [], responses = [], errors = [], checks = [];
let releaseFirst;
const firstGate = new Promise(resolve => { releaseFirst = resolve; });
let mode = 'reachable';
const app = createProductionServer({
  clientDirectory: path.resolve('dist/client'),
  dataDirectory: path.join(out, 'data-' + Date.now()),
  adminUser: 'qa-admin', adminPassword: password,
  fetchImpl: async (url, options = {}) => {
    const parsed = new URL(String(url));
    upstream.push({ url: String(url), method: options.method || 'GET' });
    if (!parsed.pathname.endsWith('/image/imageStatus')) throw new Error('Unexpected upstream request in connection QA: ' + parsed.pathname);
    if (upstream.length === 1) await firstGate;
    if (mode === 'dns') throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    return new Response(JSON.stringify({ code: mode === 'expired' ? '220004' : '220005', message: mode === 'expired' ? 'API key expired' : 'Image does not exist' }), { headers: { 'Content-Type': 'application/json' } });
  },
});
await new Promise(resolve => app.server.listen(0, '0.0.0.0', resolve));
const address = process.env.QA_HOST || Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address;
if (!address) { app.server.close(); throw new Error('QA needs a non-loopback IPv4 address to verify HTTP access.'); }
const base = `http://${address}:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--no-proxy-server'],
});
const context = await browser.newContext({ viewport: { width: 1487, height: 1058 } });
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
async function recordResponse(response) {
  const body = await response.text();
  responses.push(body);
  return JSON.parse(body);
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const testButton = () => page.getByRole('button', { name: '测试连接 QA 连接账号', exact: true });
const dialog = () => page.getByRole('dialog', { name: '测试账号连接', exact: true });
const row = () => page.locator('.account-row').filter({ hasText: 'QA 连接账号' });
const mutationSnapshot = () => JSON.stringify({ history: app.store.data.history, media: app.store.data.media, drafts: app.store.data.drafts });
let beforeProbes;
try {
  await check('Account connection controls work on authenticated plain HTTP + real IPv4', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByLabel('用户名', { exact: true }).fill('qa-admin');
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '内容标题' })).toBeVisible();
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    responses.push(await page.evaluate(async (apiKey) => {
      const response = await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA 连接账号', apiKey }) });
      if (response.status !== 201) throw new Error('Account fixture creation failed');
      return await response.text();
    }, fakeKeys[0]));
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('navigation').getByRole('button', { name: '账号管理', exact: true }).click();
    await expect(testButton()).toBeVisible();
    beforeProbes = mutationSnapshot();
    await page.screenshot({ path: path.join(out, 'account-desktop.png'), fullPage: true });
  });
  await check('Read-only probe shows loading, prevents repeat clicks and avoids claiming publishing permission', async () => {
    const probe = page.waitForResponse(response => /\/api\/accounts\/[^/]+\/test$/.test(new URL(response.url()).pathname));
    await testButton().click();
    await expect(dialog()).toBeVisible();
    await expect(dialog()).toContainText('正在从服务器连接币安');
    await expect(testButton()).toBeDisabled();
    await testButton().evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => upstream.length).toBe(1);
    releaseFirst();
    const result = (await recordResponse(await probe)).test;
    expect(result).toMatchObject({ status: 'reachable', keyStatus: 'unverified', code: '220005' });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
    await expect(dialog()).toContainText(result.title);
    await expect(dialog()).toContainText(result.message);
    await expect(dialog()).toContainText('220005');
    expect(await dialog().innerText()).not.toMatch(/密钥有效|发布权限已验证|可以正常发布/);
    expect(upstream).toHaveLength(1);
    await page.screenshot({ path: path.join(out, 'connection-reachable-desktop.png'), fullPage: true });
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await expect(row()).toContainText(result.title);
  });
  await check('DNS failures provide specific actionable details and diagnostic codes', async () => {
    mode = 'dns';
    const probe = page.waitForResponse(response => /\/api\/accounts\/[^/]+\/test$/.test(new URL(response.url()).pathname));
    await testButton().click();
    const result = (await recordResponse(await probe)).test;
    expect(result.status).toBe('error');
    expect(result.title).toMatch(/DNS/);
    await expect(dialog()).toContainText(result.title);
    await expect(dialog()).toContainText(result.message);
    await expect(dialog()).toContainText(result.code);
    await page.screenshot({ path: path.join(out, 'connection-dns-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: path.join(out, 'connection-dns-mobile.png'), fullPage: true });
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await expect(testButton()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(await page.locator('.account-table').evaluate(table => table.scrollWidth <= table.clientWidth)).toBe(true);
    const accountNameBounds = await row().locator('strong').boundingBox();
    expect(accountNameBounds.x).toBeGreaterThanOrEqual(0);
    expect(accountNameBounds.x + accountNameBounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: path.join(out, 'account-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1487, height: 1058 });
  });
  await check('Expired keys display their Binance code and replacing a key clears stale diagnostics', async () => {
    mode = 'expired';
    const probe = page.waitForResponse(response => /\/api\/accounts\/[^/]+\/test$/.test(new URL(response.url()).pathname));
    await testButton().click();
    const result = (await recordResponse(await probe)).test;
    expect(result).toMatchObject({ status: 'error', keyStatus: 'expired', code: '220004' });
    await expect(dialog()).toContainText(result.title);
    await expect(dialog()).toContainText(result.message);
    await expect(dialog()).toContainText('220004');
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await expect(row()).toContainText(result.title);
    await row().getByRole('button', { name: '编辑 QA 连接账号', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑账号', exact: true });
    await edit.locator('input[type="password"]').fill(fakeKeys[1]);
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/api\/accounts\/[^/]+$/.test(new URL(response.url()).pathname));
    await edit.getByRole('button', { name: '保存账号', exact: true }).click();
    await recordResponse(await saved);
    await expect(edit).toHaveCount(0);
    await expect(row()).not.toContainText(result.title);
    await expect(row()).not.toContainText('220004');
    mode = 'reachable';
    const retest = page.waitForResponse(response => /\/api\/accounts\/[^/]+\/test$/.test(new URL(response.url()).pathname));
    await testButton().click();
    expect((await recordResponse(await retest)).test).toMatchObject({ status: 'reachable', keyStatus: 'unverified' });
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  });
  await check('Tests send no publishing/upload requests, create no history/media/drafts and expose no secrets', async () => {
    expect(upstream).toHaveLength(4);
    expect(upstream.every(request => new URL(request.url).pathname.endsWith('/image/imageStatus'))).toBe(true);
    expect(mutationSnapshot()).toBe(beforeProbes);
    expect(await fs.readdir(path.join(app.store.directory, 'media'))).toEqual([]);
    responses.push(await page.evaluate(async () => (await fetch('/api/accounts')).text()));
    for (const key of fakeKeys) {
      expect(responses.some(response => response.includes(key))).toBe(false);
      expect(await page.locator('body').innerText()).not.toContain(key);
      expect(upstream.some(request => request.url.includes(key))).toBe(false);
      expect(await fs.readFile(path.join(app.store.directory, 'database.json'), 'utf8')).not.toContain(key);
    }
    expect(errors).toEqual([]);
  });
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ base, secureContext: false, checks, errors, probes: upstream.length }, null, 2));
  console.log(JSON.stringify({ checks, errors, probes: upstream.length }));
} finally {
  releaseFirst();
  await browser.close();
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
}
