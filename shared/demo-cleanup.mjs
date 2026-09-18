// Shared by the browser and Node store. Migration never advances edit timestamps:
// a cached older draft must not become newer than a user's server-side edits.
const SEED_TITLE = '今天的市场观察';
const SEED_BODY = '市场的每一次波动，都值得认真记录。\n分享我的观察，也期待听到你的观点。';
const SEED_KEYS = new Set([
  'id', 'type', 'title', 'body', 'tags', 'chart', 'media', 'selectedAccounts',
  'demo', 'updatedAt', 'html', 'createdAt', 'clientUpdatedAt', 'savedAt',
  'mediaIds', 'coverMediaId', 'duration',
]);
const sameList = (value, expected) => Array.isArray(value) &&
  value.length === expected.length && value.every((item, index) => item === expected[index]);
const emptyList = value => value == null || sameList(value, []);
export const isDemoAccountId = value => typeof value === 'string' && value.startsWith('demo-');

export function isOriginalDemoSeed(draft) {
  return Boolean(draft && typeof draft === 'object' && draft.demo === true &&
    draft.type === 'post' && draft.title === SEED_TITLE && draft.body === SEED_BODY &&
    sameList(draft.tags, ['BTC', '市场观察']) &&
    sameList(draft.selectedAccounts, ['demo-main', 'demo-market']) &&
    draft.chart?.symbol === 'BTCUSDT' && draft.chart?.interval === '4h' &&
    Object.keys(draft.chart).length === 2 && emptyList(draft.media) &&
    emptyList(draft.mediaIds) && !draft.coverMediaId && !draft.duration && !draft.html &&
    Object.keys(draft).every(key => SEED_KEYS.has(key)));
}

export function normalizeDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
  if (isOriginalDemoSeed(draft)) return null;
  const hasDemoSelection = Array.isArray(draft.selectedAccounts) &&
    draft.selectedAccounts.some(isDemoAccountId);
  if (draft.demo !== true && !hasDemoSelection) return draft;
  const next = { ...draft };
  if (draft.demo === true) next.demo = false;
  if (hasDemoSelection) next.selectedAccounts = draft.selectedAccounts.filter(id => !isDemoAccountId(id));
  return next;
}

export function isDemoPending(pending) {
  // The submitted payload is authoritative. Never turn a simulated request into
  // a live request, and do not alter an actual request's idempotency payload.
  return pending?.payload?.demo === true;
}

export function cleanDemoDatabase(data) {
  const drafts = data.drafts.map(normalizeDraft).filter(Boolean);
  const history = data.history.filter(entry => entry.demo !== true);
  const changed = drafts.length !== data.drafts.length ||
    drafts.some((draft, index) => draft !== data.drafts[index]) ||
    history.length !== data.history.length;
  return { changed, data: changed ? { ...data, drafts, history } : data };
}
