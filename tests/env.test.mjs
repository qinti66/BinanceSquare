import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { prepareEnvironment } from '../scripts/configure-env.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-env-test-'));
  fs.copyFileSync(new URL('../.env.example', import.meta.url), path.join(root, '.env.example'));
  t.after(() => {
    assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('square-env-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file: path.join(root, '.env'), legacy: path.join(root, '.env.production') };
}

test('fresh deployment creates editable .env and generates a persistent password only once', t => {
  const f = fixture(t);
  const result = prepareEnvironment(f.root);
  const text = fs.readFileSync(f.file, 'utf8');
  const env = parseEnv(text);
  assert.equal(result.source, 'template');
  assert.equal(env.PORT, '8081');
  assert.equal(env.HOST, '0.0.0.0');
  assert.match(env.ADMIN_PASSWORD, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(env.ADMIN_PASSWORD, result.generatedPassword);
  assert.equal((text.match(/^ADMIN_PASSWORD=/gm) || []).length, 1);
  assert.equal(prepareEnvironment(f.root).generatedPassword, undefined);
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
});

test('blank password is initialized without changing an edited port, data path or comments', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '# my server\nPORT=19281\nADMIN_USER=owner\nADMIN_PASSWORD="" # generate\nDATA_DIR="/srv/square data"\n');
  const result = prepareEnvironment(f.root);
  const text = fs.readFileSync(f.file, 'utf8');
  const env = parseEnv(text);
  assert.equal(env.PORT, '19281');
  assert.equal(env.DATA_DIR, '/srv/square data');
  assert.equal(result.username, 'owner');
  assert.match(text, /^# my server/);
  assert.equal((text.match(/^ADMIN_PASSWORD=/gm) || []).length, 1);
  assert.equal(env.ADMIN_PASSWORD, result.generatedPassword);
});

test('legacy configuration migrates without rotating credentials or deleting the original', t => {
  const f = fixture(t);
  const contents = 'PORT=19381\nADMIN_USER=legacy\nADMIN_PASSWORD="legacy#password=123456"\nDATA_DIR=.legacy-data\n';
  fs.writeFileSync(f.legacy, contents);
  const result = prepareEnvironment(f.root);
  assert.equal(result.source, 'legacy');
  assert.equal(result.generatedPassword, undefined);
  assert.equal(fs.readFileSync(f.file, 'utf8'), contents);
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), contents);
});

test('existing .env wins over legacy and preserves user-provided password exactly', t => {
  const f = fixture(t);
  const contents = 'PORT=19481\nADMIN_PASSWORD="my-password#123456"\n';
  fs.writeFileSync(f.file, contents);
  fs.writeFileSync(f.legacy, 'PORT=8080\nADMIN_PASSWORD=old-password-123456\n');
  const result = prepareEnvironment(f.root);
  assert.equal(result.source, 'existing');
  assert.equal(result.generatedPassword, undefined);
  assert.equal(fs.readFileSync(f.file, 'utf8'), contents);
});
