import fs from 'node:fs';
import path from 'node:path';
import { cleanDemoDatabase } from '../shared/demo-cleanup.mjs';
import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';

const RETRY_DELAYS = [10, 25, 50, 100, 200];
const TRANSIENT_FILE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const syncWait = delay => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);

export function createStore(directory, { fileSystem = fs, sleepSync = syncWait } = {}) {
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fileSystem.mkdirSync(path.join(directory, 'media'), { recursive: true, mode: 0o700 });
  const databasePath = path.join(directory, 'database.json');
  const keyPath = path.join(directory, 'master.key');
  const data = fileSystem.existsSync(databasePath)
    ? JSON.parse(fileSystem.readFileSync(databasePath, 'utf8'))
    : { version: 1, accounts: [], drafts: [], history: [], media: [], draftTombstones: {} };
  data.draftTombstones = Object.assign(Object.create(null), data.draftTombstones || {});
  if (!fileSystem.existsSync(keyPath)) {
    if (data.accounts.length) throw new Error('Local encryption key is missing; restore .data/master.key from backup.');
    fileSystem.writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  try { fileSystem.chmodSync(keyPath, 0o600); } catch { /* Windows ACLs are inherited. */ }
  const masterKey = fileSystem.readFileSync(keyPath);
  if (masterKey.length !== 32) throw new Error('Invalid local encryption key.');
  function retryFileOperation(operation) {
    for (let attempt = 0; ; attempt++) {
      try { return operation(); }
      catch (error) {
        if (!TRANSIENT_FILE_ERRORS.has(error.code) || attempt >= RETRY_DELAYS.length) throw error;
        sleepSync(RETRY_DELAYS[attempt]);
      }
    }
  }
  function save() {
    const temporaryPath = `${databasePath}.${randomUUID()}.tmp`;
    try {
      const contents = JSON.stringify(data, null, 2);
      retryFileOperation(() => fileSystem.writeFileSync(temporaryPath, contents, { mode: 0o600 }));
      // Windows scanners can briefly hold the destination. Keep the previous database
      // intact while retrying the atomic replacement; never delete it as a fallback.
      retryFileOperation(() => fileSystem.renameSync(temporaryPath, databasePath));
    } finally {
      try { fileSystem.unlinkSync(temporaryPath); } catch { /* Renamed or not created. */ }
    }
  }
  function encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), ciphertext: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  function decrypt(value) {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
  const cleaned = cleanDemoDatabase(data);
  if (cleaned.changed) {
    const backupPath = path.join(directory, 'database.before-demo-cleanup-v1.json');
    if (!fileSystem.existsSync(backupPath))
      fileSystem.writeFileSync(backupPath, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    data.drafts = cleaned.data.drafts;
    data.history = cleaned.data.history;
    save();
  }
  // Never automatically resend work left in flight by a stopped process.
  let recovered = false;
  for (const entry of data.history) {
    for (const result of entry.results) {
      if (result.status === 'pending') {
        result.status = 'uncertain';
        result.error = '服务重启中断了发布，请先到币安广场核对，避免重复发布。';
        recovered = true;
      }
    }
  }
  if (recovered) save();
  return { data, save, encrypt, decrypt, directory };
}

export function publicAccount(account) {
  const { id, name, color, avatar, maskedKey, createdAt, updatedAt } = account;
  return { id, name, color, avatar, maskedKey, createdAt, updatedAt, keyConfigured: Boolean(account.secret) };
}


