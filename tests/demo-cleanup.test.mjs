import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOriginalDemoSeed, normalizeDraft } from '../shared/demo-cleanup.mjs';
import { initialDraft, migrateBrowserWorkspace, localDrafts, readPending, mergeDrafts } from '../src/client.js';
import { createStore } from '../server/store.mjs';

const seed = () => ({ id: 'old-seed', type: 'post', title: '今天的市场观察', body: '市场的每一次波动，都值得认真记录。\n分享我的观察，也期待听到你的观点。', tags: ['BTC', '市场观察'], chart: { symbol: 'BTCUSDT', interval: '4h' }, media: [], selectedAccounts: ['demo-main', 'demo-market'], demo: true, updatedAt: '2026-09-18T01:00:00.000Z' });
const edited = () => ({ ...seed(), id: 'user-edited', body: '用户自己写的草稿，请保留', html: '<p>用户自己写的草稿，请保留</p>', selectedAccounts: ['demo-main', 'account-real'] });
const real = () => ({ ...edited(), id: 'real-draft', demo: false, selectedAccounts: ['account-real'], updatedAt: '2026-09-18T02:00:00.000Z' });

test('fresh workspace is empty and only the exact unedited sample is discarded', () => {
  assert.equal(isOriginalDemoSeed(seed()), true);
  assert.equal(normalizeDraft(seed()), null);
  for (const update of [{ body: '自己的内容' }, { tags: ['我的标签'] }, { chart: null }, { html: '<b>排版</b>' }, { media: [{ id: 'image' }] }, { demo: false }])
    assert.ok(normalizeDraft({ ...seed(), ...update }));
  const fresh = initialDraft();
  assert.equal(fresh.demo, false); assert.equal(fresh.body, ''); assert.equal(fresh.title, '');
  assert.deepEqual(fresh.selectedAccounts, []); assert.deepEqual(fresh.tags, []); assert.equal(fresh.chart, null);
});

test('edited sample drafts become usable drafts without losing content or advancing timestamps', () => {
  const original = edited(), migrated = normalizeDraft(original);
  assert.equal(migrated.demo, false);
  assert.deepEqual(migrated.selectedAccounts, ['account-real']);
  assert.equal(migrated.body, original.body); assert.equal(migrated.html, original.html);
  assert.equal(migrated.updatedAt, original.updatedAt);
  const current = { ...migrated, body: '服务端较新正文', updatedAt: '2026-09-18T03:00:00.000Z' };
  assert.equal(mergeDrafts([original], [current])[0].body, current.body);
  assert.deepEqual(normalizeDraft(real()), real());
});

function withStorage(fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) } });
  try { fn(values); } finally { if (descriptor) Object.defineProperty(globalThis,'localStorage',descriptor); else delete globalThis.localStorage; }
}

test('browser migration clears seed and simulated pending, retaining custom/real drafts and unrelated keys', () => withStorage(values => {
  values.set('square.active', JSON.stringify(seed()));
  values.set('square.drafts', JSON.stringify([seed(), edited(), real()]));
  values.set('square.pending', JSON.stringify({ requestId: 'simulated', payload: { demo: true }, draft: seed(), accounts: [] }));
  values.set('unrelated-setting', 'retain');
  assert.equal(migrateBrowserWorkspace(), null);
  assert.equal(values.has('square.pending'), false);
  assert.equal(values.get('unrelated-setting'), 'retain');
  assert.deepEqual(localDrafts().map(d => d.id), ['user-edited', 'real-draft']);
  assert.ok(values.has('square.before-demo-cleanup.v1'));
  const snapshot = values.get('square.before-demo-cleanup.v1');
  migrateBrowserWorkspace(); assert.equal(values.get('square.before-demo-cleanup.v1'), snapshot);
}));

test('an in-flight real publication retains its exact idempotency payload during migration', () => withStorage(values => {
  const pending = { requestId: 'actual-request', payload: { requestId: 'actual-request', demo: false, body: '自己的正文', accountIds: ['account-real'] }, draft: real(), accounts: [{ id: 'account-real' }] };
  values.set('square.active', JSON.stringify(edited())); values.set('square.pending', JSON.stringify(pending));
  assert.equal(migrateBrowserWorkspace().body, edited().body);
  assert.deepEqual(readPending().payload, pending.payload);
  assert.equal(readPending().requestId, pending.requestId);
}));

test('server cleanup backs up once and preserves real accounts, keys, media, drafts and history', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-demo-cleanup-'));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = createStore(directory);
  store.data.accounts.push({ id: 'account-real', name: '真实账号', secret: store.encrypt('test-key-kept-0123456789') });
  store.data.drafts = [seed(), edited(), real()];
  store.data.history = [{ id: 'simulated', demo: true, results: [] }, { id: 'actual', demo: false, results: [{ accountId: 'account-real', status: 'success' }] }];
  store.save();
  const key = fs.readFileSync(path.join(directory, 'master.key'));
  fs.writeFileSync(path.join(directory, 'media', 'keep-image'), 'user media');
  const cleaned = createStore(directory);
  assert.deepEqual(cleaned.data.drafts.map(d => d.id), ['user-edited', 'real-draft']);
  assert.deepEqual(cleaned.data.history.map(h => h.id), ['actual']);
  assert.equal(cleaned.decrypt(cleaned.data.accounts[0].secret), 'test-key-kept-0123456789');
  assert.deepEqual(fs.readFileSync(path.join(directory,'master.key')), key);
  assert.equal(fs.readFileSync(path.join(directory,'media','keep-image'),'utf8'), 'user media');
  const backupPath=path.join(directory,'database.before-demo-cleanup-v1.json');
  const backup=fs.readFileSync(backupPath,'utf8');
  assert.equal(JSON.parse(backup).drafts.length,3);
  createStore(directory);
  assert.equal(fs.readFileSync(backupPath,'utf8'),backup);
});
