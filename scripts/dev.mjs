import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const api = spawn(process.execPath, ["server/index.mjs"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
const web = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", ...args],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill();
  web.kill();
  setTimeout(() => process.exit(code), 150);
}
for (const p of [api, web]) {
  p.on("exit", (code) => stop(code || 0));
  p.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
