import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function prepareEnvironment(directory) {
  const filename = path.join(directory, '.env');
  const legacy = path.join(directory, '.env.production');
  let source = 'existing';
  if (!fs.existsSync(filename)) {
    const template = fs.existsSync(legacy) ? legacy : path.join(directory, '.env.example');
    fs.copyFileSync(template, filename, fs.constants.COPYFILE_EXCL);
    source = template === legacy ? 'legacy' : 'template';
  }
  fs.chmodSync(filename, 0o600);
  let contents = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  let values = parseEnv(contents);
  let generatedPassword;
  if (!values.ADMIN_PASSWORD) {
    generatedPassword = randomBytes(24).toString('base64url');
    const emptyPassword = /^[ \t]*(?:export[ \t]+)?ADMIN_PASSWORD[ \t]*=[ \t]*(?:(?:""|''|``)[ \t]*)?(?:#.*)?\r?$/gm;
    if (emptyPassword.test(contents)) {
      emptyPassword.lastIndex = 0;
      contents = contents.replace(emptyPassword, `ADMIN_PASSWORD=${generatedPassword}`);
    } else {
      contents = `${contents.trimEnd()}\nADMIN_PASSWORD=${generatedPassword}\n`;
    }
    fs.writeFileSync(filename, contents, { mode: 0o600 });
    values = parseEnv(contents);
  }
  return { source, generatedPassword, username: values.ADMIN_USER || 'admin' };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = prepareEnvironment(root);
  if (result.source === 'legacy') console.log('已从 .env.production 迁移配置到 .env，原文件保留；以后只需修改 .env。');
  if (result.source === 'template') console.log('已从 .env.example 创建 .env，可直接修改端口、账号等配置。');
  if (result.generatedPassword) {
    console.log('已生成登录密码并写入 .env，请妥善保存：');
    console.log(`  用户名：${result.username}`);
    console.log(`  密码：${result.generatedPassword}`);
  }
  console.log('服务器配置文件：.env（修改后运行 bash restart.sh）');
}
