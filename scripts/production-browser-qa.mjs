import { chromium, expect } from '@playwright/test';
import { createProductionServer } from '../server/production.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const out = path.resolve('artifacts/production-qa');
await fs.mkdir(out, { recursive: true });
const password = 'qa-only-not-a-real-deployment-password';
const app = createProductionServer({
  clientDirectory: path.resolve('dist/client'),
  dataDirectory: path.join(out, 'data-' + Date.now()),
  adminUser: 'qa-admin', adminPassword: password,
  fetchImpl: async () => { throw new Error('Real upstream is forbidden in production browser QA'); },
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
  await check('Multi-account simulated publish works through the single production port', async () => {
    await page.getByRole('checkbox').nth(0).check();
    await page.getByRole('checkbox').nth(1).check();
    await page.getByRole('button', { name: '模拟发布 2 个账号', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '确认模拟发布', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认模拟发布', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '模拟发布结果', exact: true })).toBeVisible();
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
