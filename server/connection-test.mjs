import { randomUUID } from 'node:crypto';

const STATUS_URL = 'https://www.binance.com/bapi/composite/v2/public/pgc/openApi/image/imageStatus';
const MAX_RESPONSE_BYTES = 64 * 1024;

// Inspect nested Node/Undici errors locally; never expose messages, addresses, or causes.
export function classifyConnectionError(error) {
  const queue = [error];
  const visited = new Set();
  const errors = [];
  while (queue.length && visited.size < 64) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current); errors.push(current);
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 32));
  }
  const hasCode = (...codes) => errors.some(item => codes.includes(item.code));
  const hasName = (...names) => errors.some(item => names.includes(item.name));
  if (hasCode('ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA')) return {
    code: 'DNS_ERROR', title: '服务器 DNS 解析失败',
    message: '服务器无法解析 www.binance.com，请检查服务器的 DNS 配置及域名解析网络。',
  };
  if (errors.some(item => typeof item.code === 'string' && /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/.test(item.code))) return {
    code: 'TLS_ERROR', title: '安全连接建立失败',
    message: '服务器与币安的 TLS 证书校验或握手失败，请检查系统时间、CA 证书和 HTTPS 代理配置。',
  };
  if (hasCode('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR') || hasName('TimeoutError', 'AbortError')) return {
    code: 'CONNECTION_TIMEOUT', title: '连接币安超时',
    message: '服务器连接币安超时，请检查服务器出站 HTTPS（443 端口）、网络线路及代理配置。',
  };
  if (hasCode('ECONNREFUSED')) return {
    code: 'CONNECTION_REFUSED', title: '币安连接被拒绝',
    message: '服务器连接被拒绝，请检查出站防火墙、HTTPS 代理和网络线路。',
  };
  if (errors.some(item => ['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(item.code) && typeof item.address === 'string' && item.address.includes(':'))) return {
    code: 'IPV6_UNREACHABLE', title: '服务器 IPv6 网络不可达',
    message: '服务器无法通过 IPv6 连接币安，请检查 IPv6 路由，并确认服务器具备可用的 IPv4 或 IPv6 出站连接。',
  };
  if (hasCode('ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL')) return {
    code: 'NETWORK_UNREACHABLE', title: '服务器网络不可达',
    message: '服务器无法到达币安网络，请检查网络路由、出站防火墙及代理配置。',
  };
  if (hasCode('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET')) return {
    code: 'CONNECTION_RESET', title: '币安连接已中断',
    message: '服务器与币安的连接被中断，请检查网络稳定性、出站防火墙及 HTTPS 代理。',
  };
  if (errors.some(item => typeof item.message === 'string' && /unexpected redirect|redirect count exceeded/i.test(item.message))) return {
    code: 'REDIRECT_BLOCKED', title: '币安接口发生重定向',
    message: '接口返回重定向，为保护 API Key 已停止请求，请检查网络出口和代理配置。',
  };
  return {
    code: 'CONNECTION_ERROR', title: '无法连接币安服务',
    message: '服务器未能连接币安，请检查服务器出站 HTTPS 网络、DNS 及代理配置后重试。',
  };
}

function httpFailure(status) {
  if (status >= 300 && status < 400) return { code: 'REDIRECT_BLOCKED', title: '币安接口发生重定向', message: '接口返回重定向，为保护 API Key 已停止请求，请检查网络出口和代理配置。' };
  if (status === 403 || status === 451) return { code: `HTTP_${status}`, title: '币安拒绝当前访问', message: '币安拒绝了服务器的访问，请检查服务器所在地区、网络出口及币安的访问限制；此结果不能判断 API Key 是否有效。' };
  if (status === 429 || status === 418) return { code: `HTTP_${status}`, title: '币安请求受到限制', message: '当前服务器的请求受到限流，请稍后再测试，避免连续请求。' };
  if (status === 401) return { code: 'HTTP_401', title: '币安拒绝认证请求', message: '币安拒绝了此认证请求，请核对广场 OpenAPI Key，并检查代理是否干扰认证；暂不能确认密钥有效性。' };
  if (status >= 500) return { code: `HTTP_${status}`, title: '币安服务暂不可用', message: '币安上游服务暂时无法完成请求，请稍后重试。' };
  return { code: `HTTP_${status}`, title: '币安接口请求未成功', message: '币安未接受连接测试请求，请稍后重试；暂不能确认密钥有效性。' };
}

async function responseEnvelope(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

export function createAccountConnectionTester({ fetchImpl = fetch, requestTimeout = 12_000 } = {}) {
  return async function testAccountConnection(apiKey) {
    const startedAt = Date.now();
    const finish = (details, httpStatus) => ({
      status: 'error', keyStatus: 'unverified', ...details,
      checkedAt: new Date().toISOString(), elapsedMs: Math.max(0, Date.now() - startedAt),
      ...(httpStatus === undefined ? {} : { httpStatus }),
    });
    try {
      // Query only a fresh nonexistent ticket. No presign, upload, or publish call.
      const response = await fetchImpl(STATUS_URL, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(requestTimeout),
        headers: { 'Content-Type': 'application/json', 'X-Square-OpenAPI-Key': apiKey, clienttype: 'binanceSkill' },
        body: JSON.stringify({ fileTicket: randomUUID() }),
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => {});
        return finish(httpFailure(302), response.status);
      }
      const envelope = await responseEnvelope(response);
      const rawCode = envelope && !Array.isArray(envelope) && typeof envelope === 'object' ? envelope.code : null;
      const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '';
      if (code === '220003') return finish({
        code, keyStatus: 'invalid', title: 'API Key 不存在或已失效',
        message: '币安返回密钥不存在，请从币安广场创作者中心复制 OpenAPI Key，并在编辑账号中更新。',
      }, response.status);
      if (code === '220004') return finish({
        code, keyStatus: 'expired', title: 'API Key 已过期',
        message: '币安返回密钥已过期，请在币安广场创作者中心重新生成 OpenAPI Key，并更新此账号。',
      }, response.status);
      if (!response.ok) return finish(httpFailure(response.status), response.status);
      if (!/^\d{1,10}$/.test(code) || code.includes(apiKey)) return finish({
        code: 'INVALID_RESPONSE', title: '币安返回了无法识别的响应',
        message: '收到的响应不是有效的币安接口结果，可能遇到网关或访问验证页面，请检查服务器网络出口及代理配置。',
      }, response.status);
      return finish({
        status: 'reachable', code, title: '已连接币安接口',
        message: '服务器已收到币安接口响应。本次只查询媒体状态，未发布内容或上传文件；尚未确认 API Key 有效性和发布权限。',
      }, response.status);
    } catch (error) {
      return finish(classifyConnectionError(error));
    }
  };
}
