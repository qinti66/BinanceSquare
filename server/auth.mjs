import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
export const SESSION_SECONDS = 12 * 60 * 60;
export const LOGIN_BODY_LIMIT = 8192;

// The signing secret is process-local: restarting or changing credentials ends
// old sessions. Each login gets an independent nonce, without evicting others.
export function createLoginAuth({ adminUser, adminPassword, secureCookies }) {
  const credentialHash = hash(adminUser + ':' + adminPassword);
  const sessionSecret = randomBytes(32);
  const cookieName = origin => 'square_session_' + hash(origin).toString('hex').slice(0, 12);
  const sign = (payload, origin) => createHmac('sha256', sessionSecret).update(origin + '\n' + payload).digest('base64url');
  function validCredentials(username, password) {
    return typeof username === 'string' && username.length <= 80 && !username.includes(':') &&
      typeof password === 'string' && password.length <= 512 && timingSafeEqual(credentialHash, hash(username + ':' + password));
  }
  function authenticated(request, origin) {
    const header = request.headers.authorization || '';
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    if (match && header.length < 4096 && timingSafeEqual(credentialHash, hash(Buffer.from(match[1], 'base64')))) return true;
    const prefix = cookieName(origin) + '=';
    const token = (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
    if (!token || !/^\d{13}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const [expires, nonce, signature] = token.split('.');
    const now = Date.now();
    if (+expires <= now || +expires > now + SESSION_SECONDS * 1000) return false;
    return timingSafeEqual(hash(signature), hash(sign(expires + '.' + nonce, origin)));
  }
  function sessionCookie(origin) {
    const payload = String(Date.now() + SESSION_SECONDS * 1000) + '.' + randomBytes(32).toString('base64url');
    return cookieName(origin) + '=' + payload + '.' + sign(payload, origin) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_SECONDS + (secureCookies ? '; Secure' : '');
  }
  return { authenticated, validCredentials, sessionCookie };
}

// Reject oversized/chunked bodies while leaving the socket usable for a 413.
export function readLoginBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    function cleanup() {
      request.off('data', onData); request.off('end', onEnd);
      request.off('error', onError); request.off('aborted', onAbort);
    }
    function onError(error) { cleanup(); reject(error); }
    function onAbort() { onError(new Error('Login request aborted.')); }
    function onData(chunk) {
      size += chunk.length;
      if (size > LOGIN_BODY_LIMIT) {
        cleanup(); request.resume();
        reject(Object.assign(new Error('Login body too large.'), { status: 413 }));
      } else chunks.push(chunk);
    }
    function onEnd() { cleanup(); resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); }
    request.on('data', onData); request.on('end', onEnd);
    request.on('error', onError); request.on('aborted', onAbort);
  });
}
