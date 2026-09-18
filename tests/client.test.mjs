import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { backupDraft, localDrafts, mergeDrafts, forgetLocalDraft, readPending, textBody } from '../src/client.js';

let originalStorage;
let values;
beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); },
    },
  });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});

function draft(id, body, updatedAt = '2026-09-18T05:00:00.000Z') {
  return { id, type: 'post', title: '', body, tags: [], media: [], chart: null, selectedAccounts: ['account-1'], demo: false, updatedAt };
}

test('offline backups preserve separate drafts when the active draft changes', () => {
  const first = draft('draft-a', '尚未同步的第一份内容');
  const second = draft('draft-b', '第二份内容');
  assert.equal(backupDraft(first), true);
  localStorage.setItem('square.active', JSON.stringify(second));
  assert.equal(backupDraft(second), true);
  const restored = new Map(localDrafts().map(value => [value.id, value]));
  assert.equal(restored.size, 2);
  assert.deepEqual(restored.get(first.id), first);
  assert.deepEqual(restored.get(second.id), second);
});

test('late backup of an older edit cannot overwrite the latest local draft', () => {
  const newer = draft('draft-a', '最新内容', '2026-09-18T05:00:02.000Z');
  const older = draft('draft-a', '旧内容', '2026-09-18T05:00:01.000Z');
  backupDraft(newer);
  backupDraft(older);
  assert.deepEqual(localDrafts(), [newer]);
});

test('merge chooses the newest edit regardless of service or browser input order', () => {
  const old = draft('draft-a', '服务旧版本', '2026-09-18T05:00:01.000Z');
  const fresh = draft('draft-a', '浏览器新版本', '2026-09-18T05:00:02.000Z');
  const other = draft('draft-b', '另一份');
  for (const merged of [mergeDrafts([old, other], [fresh]), mergeDrafts([fresh], [other, old])]) {
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.find(value => value.id === fresh.id), fresh);
    assert.deepEqual(merged.find(value => value.id === other.id), other);
  }
  assert.equal(old.body, '服务旧版本');
});

test('same-version merge keeps the preferred source including saved metadata', () => {
  const saved = { ...draft('draft-a', '正文'), savedAt: '2026-09-18T05:01:00.000Z' };
  assert.deepEqual(mergeDrafts([saved], [draft('draft-a', '正文')]), [saved]);
});

test('deleting one backup leaves other drafts recoverable', () => {
  backupDraft(draft('draft-a', '将删除'));
  const retained = draft('draft-b', '保留');
  backupDraft(retained);
  forgetLocalDraft('draft-a');
  assert.deepEqual(localDrafts(), [retained]);
  forgetLocalDraft('missing');
  assert.deepEqual(localDrafts(), [retained]);
});

test('storage quota failures are reported and preserve previous backups', () => {
  const retained = draft('draft-a', '已经备份');
  backupDraft(retained);
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(backupDraft(draft('draft-b', '不能备份')), false);
  assert.deepEqual(localDrafts(), [retained]);
});

test('corrupted or non-array backup data does not crash recovery', () => {
  for (const invalid of ['{broken', '{}', 'null', '"text"']) {
    values.set('square.drafts', invalid);
    assert.deepEqual(localDrafts(), []);
  }
});

test('pending recovery retains the exact request id, payload and target accounts', () => {
  const current = draft('draft-a', '真实提交正文');
  const payload = { requestId: 'publish-1', accountIds: ['account-1'], body: current.body, mediaIds: ['media-1'], type: 'post', title: '', demo: false };
  const pending = { requestId: payload.requestId, draft: current, accounts: [{ id: 'account-1', name: '主账号' }], payload };
  localStorage.setItem('square.pending', JSON.stringify(pending));
  const restored = readPending();
  assert.equal(restored.requestId, payload.requestId);
  assert.deepEqual(restored.payload, payload);
  assert.deepEqual(restored.accounts, pending.accounts);
  assert.deepEqual(restored.draft, current);
  assert.equal(restored.restored, true);
  assert.match(restored.error, /同一次提交/);
  assert.equal(JSON.stringify(restored.payload), JSON.stringify(readPending().payload));
});

test('missing, incomplete and malformed pending records do not produce a submission', () => {
  assert.equal(readPending(), null);
  for (const invalid of ['{broken', '{}', 'null', JSON.stringify({ requestId: 'not-submitted', draft: draft('draft-a', '草稿'), accounts: [] })]) {
    values.set('square.pending', invalid);
    assert.equal(readPending(), null);
  }
});

test('article body excludes its title while post body includes title and hashtags', () => {
  const content = { ...draft('draft-a', '观察正文'), title: '我的标题', tags: ['BTC', '市场观察'] };
  assert.equal(textBody({ ...content, type: 'article' }), '观察正文\n\n#BTC #市场观察');
  assert.equal(textBody(content), '我的标题\n\n观察正文\n\n#BTC #市场观察');
});

test('clearing an existing draft replaces its old backup with the latest empty edit', () => {
  backupDraft(draft('draft-a', '应被清除的旧正文'));
  const cleared = draft('draft-a', '', '2026-09-18T05:00:03.000Z');
  assert.equal(backupDraft(cleared), true);
  assert.deepEqual(localDrafts(), [cleared]);
});

