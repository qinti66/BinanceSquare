import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";
import config from "../vite.config.mjs";

test("development server blocks vault files, raw paths, encoded paths and source queries", async (t) => {
  const temporaryBase = path.resolve(
    fileURLToPath(new URL(".", import.meta.url)),
  );
  const directory = await mkdtemp(
    path.join(temporaryBase, "square-dev-security-"),
  );
  let server;
  t.after(async () => {
    await server?.close();
    // This directory was created by this test and contains only fake fixtures.
    assert.equal(path.dirname(path.resolve(directory)), temporaryBase);
    assert.ok(path.basename(directory).startsWith("square-dev-security-"));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, ".data"));
  await mkdir(path.join(directory, ".git"));
  await writeFile(
    path.join(directory, ".data", "master.key"),
    "FAKE TEST KEY; NEVER A REAL KEY",
  );
  await writeFile(
    path.join(directory, ".data", "database.json"),
    '{"test":true}',
  );
  await writeFile(path.join(directory, ".env"), "FAKE_TEST_VALUE=example");
  await writeFile(
    path.join(directory, ".env.local"),
    "FAKE_TEST_VALUE=example",
  );
  await writeFile(path.join(directory, "private.pem"), "FAKE TEST CERTIFICATE");
  await writeFile(path.join(directory, ".git", "config"), "FAKE TEST CONFIG");
  await writeFile(path.join(directory, "healthy.txt"), "public fixture");
  server = await createServer({
    configFile: false,
    root: directory,
    publicDir: false,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      fs: config.server.fs,
    },
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const absoluteVaultPath =
    directory.replaceAll("\\", "/") + "/.data/master.key";
  const blocked = [
    "/.data/master.key",
    "/.data/database.json",
    "/%2edata/master.key",
    "/.data/%6daster.key",
    "/.data/master.key?raw",
    "/.data/master.key?url",
    "/.data/master.key?raw??",
    "/.data/master.key?import&raw",
    "/.data/master.key?download=1",
    "/@fs/" + absoluteVaultPath,
    "/@fs/" + absoluteVaultPath.replace(".data", "%2edata") + "?raw",
    "/.env",
    "/.env.local",
    "/private.pem",
    "/.git/config",
  ];
  for (const requestPath of blocked) {
    const response = await fetch(base + requestPath, { method: "HEAD" });
    assert.equal(
      response.status,
      403,
      `sensitive path should be denied: ${requestPath}`,
    );
  }
  const healthy = await fetch(base + "/healthy.txt");
  assert.equal(healthy.status, 200);
  assert.equal(await healthy.text(), "public fixture");
});
