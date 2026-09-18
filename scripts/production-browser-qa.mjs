import { chromium, expect } from '@playwright/test';
import { createProductionServer } from '../server/production.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const out = path.resolve('artifacts/production-qa');
await fs.mkdir(out, { recursive: true });
const password = 'qa-only-not-a-real-deployment-password';
let publishCalls = 0;
const app = createProductionServer({
  clientDirectory: path.resolve('dist/client'),
  dataDirectory: path.join(out, 'data-' + Date.now()),
  adminUser: 'qa-admin', adminPassword: password,
  fetchImpl: async (url) => {
    if (!String(url).endsWith('/content/add')) throw new Error('Unexpected upstream in QA');
    publishCalls++;
    return new Response(JSON.stringify({ code: '000000', data: { id: String(123450 + publishCalls) } }), { headers: { 'Content-Type': 'application/json' } });
  },
});
await new Promise(resolve => app.server.listen(0, '0.0.0.0', resolve));
const address = process.env.QA_HOST || Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address;
if (!address) { app.server.close(); throw new Error('QA needs a non-loopback IPv4 address to verify HTTP secure-context restrictions.'); }
const base = `http://${address}:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--no-proxy-server'],
});
const context = await browser.newContext({ httpCredentials: { username: 'qa-admin', password }, viewport: { width: 1487, height: 1058 } });
const page = await context.newPage();
const errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
try {
  await check('Anonymous clients cannot read the application or account vault', async () => {
    for (const route of ['/', '/api/accounts', '/api/history', '/.data/master.key']) {
      const response = await fetch(base + route);
      expect(response.status).toBe(401);
    }
  });
  await check('Production app loads with Basic authentication on plain HTTP + real IPv4', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await expect(page.getByRole('textbox', { name: '内容标题' })).toBeVisible();
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
    expect(await page.locator('img').evaluateAll(imgs => imgs.every(i => i.complete && i.naturalWidth > 0))).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('square.active')).id)).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole('textbox', { name: '内容标题' })).toHaveValue('');
    await expect(page.getByRole('textbox', { name: '正文', exact: true })).toBeEmpty();
    await expect(page.locator('.chart-card')).toHaveCount(0);
    await expect(page.locator('.account-choice')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toMatch(/演示工作区|示例账号|今天的市场观察/);
    await expect(page.getByRole('button', { name: '发布到 0 个账号', exact: true })).toBeDisabled();
    await page.screenshot({ path: path.join(out, 'clean-workspace.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: path.join(out, 'clean-workspace-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1487, height: 1058 });
  });
  await check('Old browser samples disappear while authored drafts survive', async () => {
    await page.evaluate(() => {
      const seed = { id: 'browser-seed', type: 'post', title: '今天的市场观察', body: '市场的每一次波动，都值得认真记录。\n分享我的观察，也期待听到你的观点。', tags: ['BTC', '市场观察'], chart: { symbol: 'BTCUSDT', interval: '4h' }, media: [], selectedAccounts: ['demo-main', 'demo-market'], demo: true, updatedAt: '2026-09-18T01:00:00.000Z' };
      const authored = { ...seed, id: 'authored-demo', title: '我写的待发布草稿', body: '请保留我自己的内容。', chart: null };
      const real = { ...authored, id: 'real-kept', title: '已有正式草稿', demo: false, selectedAccounts: [] };
      localStorage.setItem('square.active', JSON.stringify(seed));
      localStorage.setItem('square.drafts', JSON.stringify([seed, authored, real]));
      localStorage.setItem('square.pending', JSON.stringify({ requestId: 'never-publish-demo', payload: { demo: true }, draft: seed, accounts: [] }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('textbox', { name: '内容标题' })).toHaveValue('');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('square.drafts')));
    expect(cached.map(d => d.id).sort()).toEqual(['authored-demo','real-kept']);
    expect(cached.every(d => d.demo === false && !d.selectedAccounts.some(id => id.startsWith('demo-')))).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('square.pending'))).toBeNull();
    await page.getByRole('navigation').getByRole('button', { name: '草稿箱' }).click();
    await expect(page.getByRole('heading', { name: '我写的待发布草稿' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '已有正式草稿' })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: '创作中心' }).click();
  });
  await check('HTTP UUID fallback, same-origin draft save and reload work', async () => {
    await page.getByRole('button', { name: '新建内容', exact: true }).click();
    await page.getByRole('textbox', { name: '内容标题' }).fill('服务器 HTTP 草稿');
    await page.getByRole('textbox', { name: '正文', exact: true }).fill('通过 IP 和端口访问后，草稿仍可自动保存。');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.getByText('草稿已自动保存', { exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('textbox', { name: '内容标题' })).toHaveValue('服务器 HTTP 草稿');
    await expect(page.getByRole('textbox', { name: '正文', exact: true })).toContainText('草稿仍可自动保存');
  });
  await check('Authenticated media and account APIs work from the production origin', async () => {
    const result = await page.evaluate(async () => {
      const headers = { 'Content-Type': 'application/json' };
      const r = await fetch('/api/accounts', { method: 'POST', headers, body: JSON.stringify({ name: '部署验收账号', apiKey: 'FAKE_QA_KEY_NEVER_USED_0123456789' }) });
      const account = await r.json();
      const m = await fetch('/api/media', { method: 'POST', headers, body: JSON.stringify({ name: 'qa.png', type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nEAAAAAASUVORK5CYII=' }) });
      const media = await m.json();
      const image = new Image(); image.src = media.media.url;
      await image.decode();
      await fetch('/api/accounts/' + account.account.id, { method: 'DELETE' });
      return { status: r.status, hasSecret: JSON.stringify(account).includes('FAKE_QA_KEY'), imageWidth: image.naturalWidth, mediaStatus: m.status };
    });
    expect(result).toEqual({ status: 201, hasSecret: false, imageWidth: 1, mediaStatus: 201 });
  });
  await check('Real workspace account selection and confirmed publishing use isolated mock upstream', async () => {
    await page.evaluate(async () => {
      for (const name of ['QA 账号一', 'QA 账号二']) {
        const r = await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, apiKey: 'FAKE_KEY_ONLY_IN_QA_0123456789' }) });
        if (!r.ok) throw Error('QA fixture failed');
      }
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('checkbox').nth(0).check();
    await page.getByRole('checkbox').nth(1).check();
    await page.getByRole('button', { name: '发布到 2 个账号', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '确认发布到币安广场', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认发布', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '发布结果', exact: true })).toBeVisible();
    expect(publishCalls).toBe(2);
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  });
  expect(errors).toEqual([]);
  await page.screenshot({ path: path.join(out, 'production-desktop.png'), fullPage: true });
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ base, secureContext: false, checks, errors }, null, 2));
  console.log(JSON.stringify({ checks, errors }));
} finally {
  await browser.close();
  await new Promise(resolve => app.server.close(resolve));
}
