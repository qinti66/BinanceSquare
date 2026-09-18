import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_KEYS = ['HOST', 'PORT', 'ADMIN_USER', 'ADMIN_PASSWORD', 'DATA_DIR', 'PUBLIC_ORIGIN'];

// Server settings have one source: .env. Missing settings use application
// defaults, never stale values inherited from SSH or a hosting control panel.
export function readServiceEnvironment(directory = ROOT, inherited = process.env) {
  const filename = path.join(directory, '.env');
  const configured = parseEnv(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  const values = { ...inherited };
  for (const key of CONFIG_KEYS) {
    delete values[key];
    if (Object.hasOwn(configured, key)) values[key] = configured[key];
  }
  return values;
}
