import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { classifyConnectionError } from './connection-test.mjs';

const BASE = 'https://www.binance.com/bapi/composite';
const V1 = `${BASE}/v1/public/pgc/openApi`;
const V2 = `${BASE}/v2/public/pgc/openApi`;

export class PublishError extends Error {
  constructor(message, status = 'failed', code = 'UPSTREAM_ERROR') {
    super(message); this.status = status; this.code = code;
  }
}

export function createBinancePublisher({ fetchImpl = fetch, pause = (ms) => new Promise(resolve => setTimeout(resolve, ms)), requestTimeout = 45_000 } = {}) {
  async function api(endpoint, apiKey, body, publishing = false) {
    let response;
    try {
      response = await fetchImpl(`${publishing ? V1 : V2}${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(requestTimeout),
        headers: { 'Content-Type': 'application/json', 'X-Square-OpenAPI-Key': apiKey, clienttype: 'binanceSkill' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const diagnostic = classifyConnectionError(error);
      const message = publishing
        ? `${diagnostic.title}，提交连接中断，发布结果未知；请先到币安广场核对，避免重复发布。`
        : `${diagnostic.message} 内容尚未提交，可在账号管理中测试连接。`;
      throw new PublishError(message, publishing ? 'uncertain' : 'failed', diagnostic.code);
    }
    if (publishing && response.status >= 500) {
      throw new PublishError(`币安返回 HTTP ${response.status}，发布结果未知；请先到广场核对。`, 'uncertain', `HTTP_${response.status}`);
    }
    let envelope;
    try { envelope = await response.json(); }
    catch { throw new PublishError(`币安返回无法识别的响应（HTTP ${response.status}）。`, publishing && response.ok ? 'uncertain' : 'failed'); }
    if (!response.ok || envelope?.code !== '000000') {
      const code = String(envelope?.code || `HTTP_${response.status}`).replaceAll(apiKey, 'REDACTED').replace(/[^\w-]/g, '').slice(0, 40);
      const detail = String(envelope?.message || '请求未获接受').replaceAll(apiKey, '[已隐藏]').replace(/[\x00-\x1F\x7F]/g, '').slice(0, 300);
      throw new PublishError(`币安错误 ${code}：${detail}`, 'failed', code);
    }
    return envelope.data || {};
  }

  async function poll(apiKey, fileTicket) {
    if (typeof fileTicket !== 'string' || !fileTicket) throw new PublishError('币安未返回有效上传票据。');
    for (let attempt = 0; attempt < 10; attempt++) {
      const status = await api('/image/imageStatus', apiKey, { fileTicket });
      if (status.status === 1) return status;
      if (status.status === 2) throw new PublishError('币安媒体处理失败，请检查文件格式。');
      if (attempt < 9) await pause(3000);
    }
    throw new PublishError('媒体处理超时，内容尚未提交。');
  }

  async function upload(apiKey, media, directory) {
    const video = media.type.startsWith('video/');
    const ticket = await api(video ? '/video/preSign' : '/image/presignedUrl', apiKey,
      video ? { fileName: media.name, size: media.size } : { imageName: media.name });
    let uploadUrl;
    try { uploadUrl = new URL(ticket.presignedUrl); } catch { throw new PublishError('上传地址无效。'); }
    const host = uploadUrl.hostname.toLowerCase();
    if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password || (uploadUrl.port && uploadUrl.port !== '443') || isIP(host) || host.includes(':') || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new PublishError('拒绝不安全的媒体上传地址。');
    }
    let response;
    try {
      response = await fetchImpl(uploadUrl.href, {
        method: 'PUT', redirect: 'error', headers: { 'Content-Type': media.type },
        body: await fs.readFile(path.join(directory, 'media', media.id)), signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      const diagnostic = classifyConnectionError(error);
      throw new PublishError(`媒体上传失败。${diagnostic.message} 内容尚未提交。`, 'failed', diagnostic.code);
    }
    if (!response.ok) throw new PublishError(`媒体上传失败（HTTP ${response.status}），内容尚未提交。`);
    const processed = await poll(apiKey, ticket.fileTicket);
    if (!video && (typeof processed.imageUrl !== 'string' || !processed.imageUrl.startsWith('https://'))) {
      throw new PublishError('币安未返回有效图片地址。');
    }
    return video ? ticket.fileTicket : processed.imageUrl;
  }

  return async function publish({ apiKey, content, media, cover, directory }) {
    const payload = { contentType: content.type === 'article' ? 2 : content.type === 'video' ? 3 : 1, bodyTextOnly: content.body };
    if (content.type === 'article') {
      payload.title = content.title;
      if (cover || media[0]) payload.cover = await upload(apiKey, cover || media[0], directory);
    } else if (content.type === 'video') {
      payload.fileTicket = await upload(apiKey, media[0], directory);
      payload.cover = await upload(apiKey, cover, directory);
      payload.videoTimeSeconds = content.duration;
      payload.isPublish = true;
    } else if (media.length) {
      payload.imageList = [];
      for (const image of media) payload.imageList.push(await upload(apiKey, image, directory));
    }
    const result = await api('/content/add', apiKey, payload, true);
    const rawId = result.id === undefined || result.id === null ? '' : String(result.id);
    const id = /^\d{1,40}$/.test(rawId) ? rawId : null;
    return { status: 'success', postId: id, postUrl: id ? `https://www.binance.com/square/post/${id}` : null };
  };
}

