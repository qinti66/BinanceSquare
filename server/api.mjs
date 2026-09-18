import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createStore, publicAccount } from './store.mjs';
import { createBinancePublisher } from './binance.mjs';

const MB = 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const API_KEY = /^[^\s\x00-\x1f\x7f]{8,2048}$/;
const TYPES = new Set(['post', 'article', 'video']);
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo']);
const FRONTENDS = ['http://127.0.0.1:4173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://localhost:5173'];

class HttpError extends Error { constructor(status, message, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; } }
const requireValue = (condition, message, status = 400, code) => { if (!condition) throw new HttpError(status, message, code); };
const stringValue = (value, max = 100000) => typeof value === 'string' && value.length <= max;
const publicEntry = ({ fingerprint, ...entry }) => entry;

function fileMatchesMime(data, mime) {
  const ascii = (start, length) => data.subarray(start, start + length).toString('ascii');
  if (mime === 'image/png') return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (mime === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (mime === 'video/x-msvideo') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ';
  if (mime === 'video/webm') return data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (mime === 'video/mp4' || mime === 'video/quicktime') return ['ftyp', 'moov', 'mdat', 'wide'].includes(ascii(4, 4));
  return false;
}

async function readJson(request, limit = MB) {
  requireValue(request.headers['content-type']?.split(';')[0].trim() === 'application/json', '请使用 application/json 请求。', 415);
  requireValue(!request.headers['content-encoding'] || request.headers['content-encoding'] === 'identity', '不支持压缩请求体。', 415);
  requireValue(!request.headers['content-length'] || Number(request.headers['content-length']) <= limit, '请求内容过大。', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    requireValue(size <= limit, '请求内容过大。', 413);
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON 格式无效。'); }
  requireValue(result && typeof result === 'object' && !Array.isArray(result), '请求必须是 JSON 对象。');
  return result;
}

export function createApiServer({ dataDirectory = path.resolve('.data'), fetchImpl = fetch, pause, allowedOrigins = FRONTENDS } = {}) {
  const store = createStore(dataDirectory);
  const publisher = createBinancePublisher({ fetchImpl, pause });
  const active = new Set();
  const send = (response, status, data) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    response.end(JSON.stringify(data));
  };
  const mediaById = id => store.data.media.find(item => item.id === id);
  const accountById = id => store.data.accounts.find(item => item.id === id);
  function safeAccountFields(input, previous = {}) {
    const name = input.name === undefined ? previous.name : input.name;
    requireValue(stringValue(name, 60) && name.trim(), '请填写 1–60 字的展示名称。');
    const color = input.color === undefined ? previous.color || '#F0B90B' : input.color;
    requireValue(typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color), '账号颜色格式无效。');
    const avatar = input.avatar === undefined ? previous.avatar || name.slice(0, 1) : input.avatar;
    requireValue(stringValue(avatar, 8), '头像请使用最多 8 字的文字或表情。');
    return { name: name.trim(), color, avatar };
  }
  function secretFields(apiKey) {
    requireValue(typeof apiKey === 'string' && API_KEY.test(apiKey), '请填写有效格式的 Square OpenAPI Key（8–2048 字符，无空格）。');
    return { secret: store.encrypt(apiKey), maskedKey: apiKey.length > 12 ? `${apiKey.slice(0, 5)}…${apiKey.slice(-4)}` : `••••…${apiKey.slice(-2)}` };
  }
  function validateContent(input) {
    requireValue(typeof input.demo === 'boolean', '请明确指定演示或真实发布模式。');
    requireValue(typeof input.requestId === 'string' && ID.test(input.requestId), '发布必须带有唯一 requestId。');
    requireValue(TYPES.has(input.type), '请选择帖子、文章或视频。');
    requireValue(stringValue(input.body ?? '', 100000), '正文过长或格式无效。');
    requireValue(input.type === 'video' || (input.body ?? '').trim(), '正文不能为空。');
    requireValue(stringValue(input.title ?? '', 200), '标题最多 200 字。');
    if (input.type === 'article') requireValue(input.title?.trim(), '文章需要标题。');
    requireValue(Array.isArray(input.accountIds) && input.accountIds.length > 0 && input.accountIds.length <= 50 && input.accountIds.every(id => typeof id === 'string' && ID.test(id)), '请选择 1–50 个发布账号。');
    const accountIds = [...new Set(input.accountIds)];
    if (!input.demo) requireValue(accountIds.every(id => accountById(id)?.secret), '部分账号不存在或尚未配置 API Key。');
    const mediaIds = input.mediaIds ?? [];
    requireValue(Array.isArray(mediaIds) && mediaIds.length <= 4 && mediaIds.every(id => typeof id === 'string' && ID.test(id)), '媒体列表格式无效，最多 4 张图片。');
    const media = mediaIds.map(mediaById);
    requireValue(media.every(Boolean), '部分媒体文件不存在，请重新添加。');
    const coverMediaId = input.coverMediaId || null;
    const cover = coverMediaId ? mediaById(coverMediaId) : null;
    requireValue(!coverMediaId || cover?.type.startsWith('image/'), '封面必须是已上传的图片。');
    if (input.type === 'video') {
      requireValue(media.length === 1 && media[0].type.startsWith('video/'), '视频内容需要且只能包含一个视频。');
      requireValue(cover, '视频需要封面，请上传封面或从视频截取一帧。');
      requireValue(typeof input.duration === 'number' && Number.isFinite(input.duration) && input.duration > 0 && input.duration <= 86400, '请提供有效的视频时长（秒）。');
    } else {
      requireValue(media.every(item => item.type.startsWith('image/')), '帖子和文章只能添加图片。');
      requireValue(input.type !== 'article' || media.length <= 1, '文章最多支持一张封面图片。');
      requireValue(input.type !== 'post' || !cover, '短帖请通过图片列表添加媒体。');
      requireValue(input.type !== 'article' || !cover || !media.length || media[0].id === cover.id, '文章只能指定一张封面。');
    }
    return { requestId: input.requestId, accountIds, type: input.type, title: input.title || '', body: input.body || '', mediaIds, coverMediaId, duration: input.type === 'video' ? input.duration : null, demo: input.demo };
  }
  async function execute(entry, content) {
    try {
      for (const result of entry.results) {
        const account = accountById(result.accountId);
        try {
          if (content.demo) {
            Object.assign(result, { status: 'success', demo: true, postId: null, postUrl: null });
          } else {
            // Keys are decrypted only in memory for this account's explicitly requested publish.
            requireValue(account?.secret, '账号已被删除，请重新选择。');
            const outcome = await publisher({ apiKey: store.decrypt(account.secret), content, media: content.mediaIds.map(mediaById), cover: content.coverMediaId ? mediaById(content.coverMediaId) : null, directory: store.directory });
            Object.assign(result, outcome);
          }
        } catch (error) {
          result.status = error.status === 'uncertain' ? 'uncertain' : 'failed';
          result.error = error.name === 'PublishError' || error.constructor.name === 'PublishError' || error instanceof HttpError ? error.message : '本地处理失败，内容未能完成提交。';
          result.code = error.code || 'LOCAL_ERROR';
        }
        result.completedAt = new Date().toISOString();
        store.save();
      }
      entry.completedAt = new Date().toISOString();
      store.save();
    } catch {
      // A result could already be live on Binance. Keep it, stop before sending any
      // remaining accounts, and let same-request replay retry persistence only.
      for (const result of entry.results) {
        if (result.status === 'pending') Object.assign(result, {
          status: 'failed', code: 'STORAGE_ERROR',
          error: '本地发布记录保存失败，该账号尚未提交。', completedAt: new Date().toISOString(),
        });
      }
      entry.completedAt = new Date().toISOString();
      try { store.save(); } catch { /* The initial pending ledger remains on disk. */ }
      throw new HttpError(503, '本地发布记录保存失败，请重试查询同一次提交；请勿新建重复发布。', 'STORAGE_ERROR');
    } finally {
      active.delete(entry.requestId);
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host || '';
      requireValue(/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(host), '仅允许本机访问。', 403, 'HOST_REJECTED');
      const origin = request.headers.origin;
      requireValue(!origin || origin === `http://${host}` || allowedOrigins.includes(origin), '拒绝跨站请求。', 403, 'ORIGIN_REJECTED');
      requireValue(request.headers['sec-fetch-site'] !== 'cross-site', '拒绝跨站请求。', 403, 'ORIGIN_REJECTED');
      const url = new URL(request.url, `http://${host}`);
      const pathname = url.pathname;
      const method = request.method;
      if (method === 'GET' && pathname === '/api/health') return send(response, 200, { ok: true, localOnly: true, limits: { imageBytes: 10 * MB, videoBytes: 100 * MB }, capabilities: { post: true, article: true, video: true, richText: false, nativeChart: false, remoteHistory: false } });
      if (pathname === '/api/accounts' && method === 'GET') return send(response, 200, { accounts: store.data.accounts.map(publicAccount) });
      if (pathname === '/api/accounts' && method === 'POST') {
        const input = await readJson(request);
        requireValue(store.data.accounts.length < 100, '本地最多保存 100 个账号。');
        const now = new Date().toISOString();
        const account = { id: randomUUID(), ...safeAccountFields(input), ...secretFields(input.apiKey), createdAt: now, updatedAt: now };
        store.data.accounts.push(account); store.save();
        return send(response, 201, { account: publicAccount(account) });
      }
      const accountRoute = pathname.match(/^\/api\/accounts\/([\w-]+)$/);
      if (accountRoute && ['PATCH', 'DELETE'].includes(method)) {
        const account = accountById(accountRoute[1]);
        requireValue(account, '账号不存在。', 404);
        if (method === 'DELETE') {
          store.data.accounts = store.data.accounts.filter(item => item.id !== account.id); store.save();
          return send(response, 200, { deleted: true });
        }
        const input = await readJson(request);
        const updated = { ...safeAccountFields(input, account) };
        if (input.apiKey !== undefined && input.apiKey !== '') Object.assign(updated, secretFields(input.apiKey));
        Object.assign(account, updated, { updatedAt: new Date().toISOString() }); store.save();
        return send(response, 200, { account: publicAccount(account) });
      }
      if (pathname === '/api/drafts' && method === 'GET') return send(response, 200, { drafts: [...store.data.drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
      const draftRoute = pathname.match(/^\/api\/drafts\/([\w-]{1,100})$/);
      if (draftRoute && ['PUT', 'DELETE'].includes(method)) {
        const id = draftRoute[1];
        if (method === 'DELETE') {
          // Persist tombstones even when a slow PUT has not finished reading its body.
          // A deliberately new draft always gets a new UUID in the client.
          store.data.draftTombstones[id] = new Date().toISOString();
          store.data.drafts = store.data.drafts.filter(item => item.id !== id); store.save();
          return send(response, 200, { deleted: true });
        }
        const input = await readJson(request, 2 * MB);
        requireValue(!Object.hasOwn(store.data.draftTombstones, id), '草稿已删除，旧的自动保存请求已被忽略。', 409, 'DRAFT_DELETED');
        requireValue(TYPES.has(input.type), '草稿类型无效。');
        requireValue(stringValue(input.body ?? '', 100000) && stringValue(input.title ?? '', 200) && stringValue(input.html ?? '', 500000), '草稿内容过长。');
        requireValue(typeof input.updatedAt === 'string' && Number.isFinite(Date.parse(input.updatedAt)), '草稿必须包含有效的编辑时间 updatedAt。');
        const editedAt = new Date(input.updatedAt).toISOString();
        const previous = store.data.drafts.find(item => item.id === id);
        const previousEditedAt = previous?.clientUpdatedAt || previous?.updatedAt;
        requireValue(!previousEditedAt || Date.parse(editedAt) >= Date.parse(previousEditedAt), '已有更新的草稿版本，旧的自动保存请求已被忽略。', 409, 'DRAFT_STALE');
        const draft = { id, type: input.type, title: input.title || '', body: input.body || '', html: input.html || '', createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: editedAt, clientUpdatedAt: editedAt, savedAt: new Date().toISOString() };
        for (const key of ['tags', 'chart', 'media', 'mediaIds', 'selectedAccounts', 'coverMediaId', 'duration', 'demo']) if (input[key] !== undefined) draft[key] = input[key];
        requireValue(JSON.stringify(draft).length < MB, '草稿媒体请先上传，勿嵌入文件。', 413);
        // A same-version retry is safe; conflicting edits sharing a millisecond are not.
        if (previous?.clientUpdatedAt === editedAt) {
          const comparable = value => { const { createdAt, savedAt, ...content } = value; return JSON.stringify(content); };
          requireValue(comparable(previous) === comparable(draft), '该编辑版本已保存其他内容，请先读取最新草稿。', 409, 'DRAFT_VERSION_CONFLICT');
          return send(response, 200, { draft: previous, replayed: true });
        }
        store.data.drafts = store.data.drafts.filter(item => item.id !== id); store.data.drafts.push(draft); store.save();
        return send(response, 200, { draft });
      }
      if (pathname === '/api/media' && method === 'POST') {
        const input = await readJson(request, 140 * MB);
        requireValue(MIME.has(input.type), '支持 PNG/JPEG/GIF/WebP 图片和 MP4/MOV/WebM/AVI 视频。', 415);
        requireValue(stringValue(input.name, 200) && input.name.trim(), '媒体文件名无效。');
        requireValue(typeof input.data === 'string', '缺少 Base64 文件内容。');
        const base64 = input.data.replace(/^data:[^;]+;base64,/, '');
        requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(base64) && base64.length % 4 === 0, '文件 Base64 编码无效。');
        const buffer = Buffer.from(base64, 'base64');
        const maxSize = input.type.startsWith('image/') ? 10 * MB : 100 * MB;
        requireValue(buffer.length > 0 && buffer.length <= maxSize, `文件不可为空，图片上限 10 MB，视频上限 100 MB。`, 413);
        requireValue(fileMatchesMime(buffer, input.type), '文件内容与声明的媒体格式不匹配。', 415);
        const id = randomUUID();
        const media = { id, url: `/api/media/${id}`, type: input.type, name: path.basename(input.name.replaceAll('\\', '/')), size: buffer.length, createdAt: new Date().toISOString() };
        for (const key of ['duration', 'width', 'height']) if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] > 0) media[key] = input[key];
        fs.writeFileSync(path.join(store.directory, 'media', id), buffer, { mode: 0o600, flag: 'wx' });
        store.data.media.push(media); store.save();
        return send(response, 201, { media });
      }
      const mediaRoute = pathname.match(/^\/api\/media\/([\w-]+)$/);
      if (mediaRoute && method === 'GET') {
        const media = mediaById(mediaRoute[1]);
        requireValue(media, '媒体文件不存在。', 404);
        const filePath = path.join(store.directory, 'media', media.id);
        requireValue(fs.existsSync(filePath), '媒体文件不存在。', 404);
        const headers = { 'Content-Type': media.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600', 'Cross-Origin-Resource-Policy': 'same-origin', 'Accept-Ranges': 'bytes' };
        if (request.headers.range) {
          const match = request.headers.range.match(/^bytes=(\d+)-(\d*)$/);
          requireValue(match, '不支持该文件范围。', 416);
          const start = Number(match[1]); const end = match[2] ? Math.min(Number(match[2]), media.size - 1) : media.size - 1;
          requireValue(start <= end && start < media.size, '文件范围无效。', 416);
          response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${media.size}`, 'Content-Length': end - start + 1 });
          fs.createReadStream(filePath, { start, end }).pipe(response);
        } else {
          response.writeHead(200, { ...headers, 'Content-Length': media.size }); fs.createReadStream(filePath).pipe(response);
        }
        return;
      }
      if (pathname === '/api/history' && method === 'GET') return send(response, 200, { history: [...store.data.history].reverse().map(publicEntry) });
      if (pathname === '/api/publish' && method === 'POST') {
        const input = await readJson(request);
        const content = validateContent(input);
        const fingerprint = createHash('sha256').update(JSON.stringify({ ...content, requestId: undefined, accountIds: [...content.accountIds].sort() })).digest('hex');
        const previous = store.data.history.find(item => item.requestId === content.requestId);
        if (previous) {
          requireValue(previous.fingerprint === fingerprint, 'requestId 已用于不同内容，请重新确认后生成新编号。', 409, 'IDEMPOTENCY_CONFLICT');
          if (!active.has(content.requestId)) {
            try { store.save(); }
            catch { throw new HttpError(503, '本地发布记录尚未保存，请稍后查询同一次提交。', 'STORAGE_ERROR'); }
          }
          return send(response, active.has(content.requestId) ? 202 : 200, { ...publicEntry(previous), replayed: true });
        }
        const entry = { id: randomUUID(), requestId: content.requestId, fingerprint, demo: content.demo, type: content.type, title: content.title, body: content.body, mediaIds: content.mediaIds, coverMediaId: content.coverMediaId, createdAt: new Date().toISOString(), results: content.accountIds.map(accountId => ({ accountId, accountName: accountById(accountId)?.name || (content.demo ? '演示账号' : '未知账号'), status: 'pending', demo: content.demo })) };
        store.data.history.push(entry);
        try { store.save(); }
        catch {
          // Nothing has been sent yet. Remove the uncommitted in-memory job so an
          // identical request can safely start once local storage becomes available.
          store.data.history = store.data.history.filter(item => item !== entry);
          throw new HttpError(503, '本地发布记录无法保存，内容尚未提交，请稍后重试本次提交。', 'STORAGE_ERROR');
        }
        active.add(content.requestId);
        await execute(entry, content);
        return send(response, 200, publicEntry(entry));
      }
      throw new HttpError(404, '接口不存在。', 'NOT_FOUND');
    } catch (error) {
      const known = error instanceof HttpError;
      send(response, known ? error.status : 500, { error: known ? error.message : '本地服务处理失败，请稍后重试。', code: known ? error.code : 'INTERNAL_ERROR' });
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 15_000;
  return { server, store };
}

