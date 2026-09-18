import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApiServer } from './api.mjs';
import { readServiceEnvironment } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const hash = value => createHash('sha256').update(value).digest();
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

// Accept genuine IPv4/IPv6 addresses and DNS hostnames, never URL credentials,
// paths, whitespace or ambiguous ports. No forwarded headers are implicitly trusted.
function validHost(host) {
  if (typeof host !== 'string' || host.length > 300 || /[\s/@\\?#%]/.test(host)) return false;
  const match = host.match(/^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/);
  if (!match || (match[2] && (+match[2] < 1 || +match[2] > 65535))) return false;
  const name = match[1];
  if (name.startsWith('[')) return isIP(name.slice(1, -1)) === 6;
  if (isIP(name)) return true;
  if (/^[0-9.]+$/.test(name)) return false;
  return name.length <= 253 && name.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

export function readProductionConfig(env = process.env) {
  const port = Number(env.PORT || 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const host = env.HOST || '0.0.0.0';
  if (!isIP(host) && (!validHost(host) || host.includes(':'))) throw new Error('HOST must be a valid bind address or hostname.');
  return { host, port, adminUser: env.ADMIN_USER || 'admin', adminPassword: env.ADMIN_PASSWORD,
    dataDirectory: path.resolve(ROOT, env.DATA_DIR || '.data'), publicOrigin: env.PUBLIC_ORIGIN || undefined };
}

export function createProductionServer({ clientDirectory = path.join(ROOT, 'dist', 'client'),
  dataDirectory = path.join(ROOT, '.data'), adminUser = 'admin', adminPassword, publicOrigin,
  fetchImpl = fetch, pause, logger = console, shutdownTimeoutMs = 300_000 } = {}) {
  if (typeof adminUser !== 'string' || !adminUser.length || adminUser.length > 80 || /[:\x00-\x1f\x7f]/.test(adminUser))
    throw new Error('ADMIN_USER must contain 1-80 characters without colons or control characters.');
  if (typeof adminPassword !== 'string' || adminPassword.length < 16 || adminPassword.length > 512 || /[\x00-\x1f\x7f]/.test(adminPassword))
    throw new Error('ADMIN_PASSWORD is required and must contain 16-512 characters without control characters.');
  let publicUrl;
  if (publicOrigin) {
    try { publicUrl = new URL(publicOrigin); } catch { throw new Error('PUBLIC_ORIGIN must be an HTTPS origin.'); }
    if (publicUrl.protocol !== 'https:' || publicUrl.origin !== publicOrigin || !validHost(publicUrl.host))
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path, trailing slash, credentials or query.');
  }
  const clientRoot = fs.realpathSync(clientDirectory);
  if (!fs.statSync(clientRoot).isDirectory() || !fs.existsSync(path.join(clientRoot, 'index.html')))
    throw new Error('Production build is missing. Run npm run build first.');
  const dataRoot = fs.existsSync(dataDirectory) ? fs.realpathSync(dataDirectory) : path.resolve(dataDirectory);
  if (inside(clientRoot, dataRoot)) throw new Error('DATA_DIR must be outside dist/client.');
  const credentialHash = hash(`${adminUser}:${adminPassword}`);
  const api = createApiServer({ dataDirectory, fetchImpl, pause, accessPolicy: () => true, localOnly: false });
  let draining = false;
  let stopPromise;
  const reply = (response, status, data, extra = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    response.end(JSON.stringify(data));
  };
  function authenticated(request) {
    const header = request.headers.authorization || '';
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    const supplied = match && header.length < 4096 ? Buffer.from(match[1], 'base64') : Buffer.alloc(0);
    return timingSafeEqual(credentialHash, hash(supplied));
  }
  function findStaticFile(pathname) {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.some(segment => segment === '..' || segment.startsWith('.') || /[\\\x00-\x1f\x7f]/.test(segment)) ||
        segments.some(segment => /^(?:package(?:-lock)?\.json|database\.json|AGENTS\.md)$/i.test(segment)) ||
        /\.(?:map|mjs|cjs|key|pem|env|log|toml|lock|md|bak|db|sqlite)$/i.test(pathname)) return { forbidden: true };
    const candidate = path.resolve(clientRoot, `.${pathname}`);
    if (!inside(clientRoot, candidate)) return { forbidden: true };
    let current = clientRoot;
    for (const segment of segments) {
      current = path.join(current, segment);
      try { if (fs.lstatSync(current).isSymbolicLink()) return { forbidden: true }; }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {}; throw error; }
    }
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) return {};
      if (!inside(clientRoot, fs.realpathSync(candidate))) return { forbidden: true };
      return { file: candidate, stat };
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {}; throw error; }
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      const host = request.headers.host || '';
      if (!validHost(host)) return reply(response, 400, { error: 'Invalid Host header.' });
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) return reply(response, 400, { error: 'Invalid request target.' });
      let pathname;
      try { pathname = decodeURIComponent(request.url.split(/[?#]/, 1)[0]); }
      catch { return reply(response, 400, { error: 'Invalid URL encoding.' }); }
      if (pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method))
        return reply(response, draining ? 503 : 200, { ok: !draining, service: 'square-studio', pid: process.pid });
      if (draining) return reply(response, 503, { error: 'Service is stopping. Retry after restart.' }, { Connection: 'close', 'Retry-After': '5' });
      if (publicUrl && host.toLowerCase() !== publicUrl.host.toLowerCase())
        return reply(response, 403, { error: 'Host does not match PUBLIC_ORIGIN.' });
      if (!authenticated(request)) return reply(response, 401, { error: 'Authentication required.' },
        { 'WWW-Authenticate': 'Basic realm="Square Studio", charset="UTF-8"' });
      const expectedOrigin = publicUrl?.origin || `http://${host}`;
      if ((request.headers.origin && request.headers.origin !== expectedOrigin) ||
          ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']) ||
          (MUTATIONS.has(request.method) && request.headers.origin !== expectedOrigin))
        return reply(response, 403, { error: 'Cross-site requests are not allowed.', code: 'ORIGIN_REJECTED' });
      if (pathname === '/api' || pathname.startsWith('/api/')) return await api.handler(request, response);
      if (!['GET', 'HEAD'].includes(request.method)) return reply(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
      let result = findStaticFile(pathname);
      if (result.forbidden) return reply(response, 403, { error: 'Access denied.' });
      // Only document navigation gets SPA fallback; missing JS/images remain 404.
      if (!result.file && !path.posix.extname(pathname) && request.headers.accept?.includes('text/html'))
        result = findStaticFile('/index.html');
      if (pathname === '/') result = findStaticFile('/index.html');
      if (result.forbidden) return reply(response, 403, { error: 'Access denied.' });
      if (!result.file) return reply(response, 404, { error: 'Not found.' });
      const etag = `W/"${result.stat.size.toString(16)}-${Math.trunc(result.stat.mtimeMs).toString(16)}"`;
      const extension = path.extname(result.file).toLowerCase();
      const immutable = pathname.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(pathname);
      const headers = { 'Content-Type': TYPES[extension] || 'application/octet-stream',
        'Cache-Control': extension === '.html' ? 'private, no-cache' : immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=3600',
        ETag: etag, 'Last-Modified': result.stat.mtime.toUTCString() };
      if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers); return response.end(); }
      response.writeHead(200, { ...headers, 'Content-Length': result.stat.size });
      if (request.method === 'HEAD') return response.end();
      fs.createReadStream(result.file).on('error', () => response.destroy()).pipe(response);
    } catch {
      if (response.headersSent) response.destroy();
      else reply(response, 500, { error: 'Service could not complete this request.' });
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  function shutdown() {
    if (stopPromise) return stopPromise;
    draining = true;
    logger.info('Stopping: waiting for active requests and publications (up to 300 seconds).');
    stopPromise = (async () => {
      let timer;
      const closed = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections();
      const done = Promise.all([closed, api.whenIdle()]).then(() => false);
      const timedOut = await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => resolve(true), shutdownTimeoutMs); })]);
      clearTimeout(timer);
      if (timedOut) {
        logger.error('Shutdown deadline reached; forcing connection close. In-flight publication results may be uncertain. Verify Binance Square before resubmitting.');
        server.closeAllConnections();
      } else logger.info('Stopped: all active requests and publications completed.');
      return { timedOut };
    })();
    return stopPromise;
  }
  return { server, store: api.store, shutdown };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const config = readProductionConfig(readServiceEnvironment());
    const app = createProductionServer(config);
    app.server.on('error', error => { console.error(`Production server failed: ${error.code || error.message}`); process.exitCode = 1; });
    app.server.listen(config.port, config.host, () => {
      console.log(`Square Studio listening on ${config.host}:${config.port}. Authentication enabled.`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      app.shutdown().then(({ timedOut }) => process.exit(timedOut ? 1 : 0)).catch(() => process.exit(1));
    });
  } catch (error) {
    console.error(`Production startup refused: ${error.message}`);
    process.exitCode = 1;
  }
}
