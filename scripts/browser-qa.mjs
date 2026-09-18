import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { createApiServer } from "../server/api.mjs";
import fs from "node:fs/promises";
import path from "node:path";
const out = path.resolve("artifacts/browser-qa");
await fs.mkdir(out, { recursive: true });
const dataDirectory = path.join(out, "data-" + Date.now());
const api = createApiServer({
  dataDirectory,
  allowedOrigins: ["http://127.0.0.1:5175"],
  fetchImpl: async () => {
    throw Error("Real upstream requests are disabled in browser QA");
  },
});
const saveOriginal = api.store.save;
api.store.save = () => { try { return saveOriginal(); } catch (error) { console.error('QA_STORE_ERROR', error.code, error.message); throw error; } };
await new Promise((r) => api.server.listen(8788, "127.0.0.1", r));
const vite = await createServer({
  server: {
    port: 5175,
    host: "127.0.0.1",
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8788", changeOrigin: false } },
  },
});
await vite.listen();
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const context = await browser.newContext({
  viewport: { width: 1487, height: 1058 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [],
  checks = [];
page.on("pageerror", (e) =>
  errors.push({ kind: "pageerror", message: e.message }),
);
page.on("console", (m) => {
  if (m.type() === "error") errors.push({ kind: "console", message: m.text() });
});
page.on("response", (r) => {
  if (r.status() >= 400)
    errors.push({ kind: "http", status: r.status(), url: r.url() });
});
const check = async (name, fn) => {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  if (only && !name.includes(only)) return;
  await fn();
  checks.push(name);
  console.log("PASS " + name);
};
try {
  await page.goto("http://127.0.0.1:5175", { waitUntil: "networkidle" });
  await page.getByRole("textbox", { name: "内容标题" }).waitFor();
  await page.getByText("草稿已自动保存", { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(out, "desktop-initial.png"),
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      initial: await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        chart: document
          .querySelector(".chart-card")
          .getBoundingClientRect()
          .toJSON(),
        body: document
          .querySelector(".editor-panel")
          .getBoundingClientRect()
          .toJSON(),
        right: document
          .querySelector(".publish-panel")
          .getBoundingClientRect()
          .toJSON(),
      })),
    }),
  );
  if (process.argv.includes("--capture-only")) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(out, "mobile-initial.png"),
      fullPage: true,
    });
    console.log(
      JSON.stringify({
        mobile: await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })),
      }),
    );
  } else if (process.argv.includes("--extended")) {
    await check(
      "Video upload extracts thumbnail and duration, survives reload, then simulates publish",
      async () => {
        const fixture = await page.evaluate(async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 320;
          canvas.height = 180;
          const ctx = canvas.getContext("2d");
          const stream = canvas.captureStream(12);
          const type = [
            "video/mp4;codecs=avc1.42001E",
            "video/mp4",
            "video/webm;codecs=vp8",
          ].find((t) => MediaRecorder.isTypeSupported(t));
          if (!type) throw Error("No supported recorder");
          const rec = new MediaRecorder(stream, { mimeType: type });
          const chunks = [];
          const finished = new Promise((resolve) => {
            rec.ondataavailable = (e) => {
              if (e.data.size) chunks.push(e.data);
            };
            rec.onstop = resolve;
          });
          let frame = 0;
          const timer = setInterval(() => {
            ctx.fillStyle = "#18232f";
            ctx.fillRect(0, 0, 320, 180);
            ctx.fillStyle = "#f0b90b";
            ctx.font = "24px sans-serif";
            ctx.fillText("QA VIDEO " + frame++, 25, 95);
          }, 70);
          rec.start();
          await new Promise((r) => setTimeout(r, 1600));
          rec.stop();
          await finished;
          clearInterval(timer);
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: type.split(";")[0] });
          return {
            type: blob.type,
            data: await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve(String(reader.result).split(",")[1]);
              reader.readAsDataURL(blob);
            }),
          };
        });
        const file = path.join(
          out,
          fixture.type === "video/mp4" ? "fixture.mp4" : "fixture.webm",
        );
        await fs.writeFile(file, Buffer.from(fixture.data, "base64"));
        await page.getByRole("button", { name: "视频", exact: true }).click();
        await page
          .getByRole("button", { name: "保存并切换", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "内容标题" })
          .fill("QA 视频内容");
        await page.locator("input[type=file]").setInputFiles(file);
        await expect(page.locator(".video-upload video")).toBeVisible({
          timeout: 30000,
        });
        const draft = await page.evaluate(() =>
          JSON.parse(localStorage.getItem("square.active")),
        );
        expect(draft.media[0].duration).toBeGreaterThan(0);
        expect(draft.media[0].coverMediaId).toBeTruthy();
        await page.getByText("草稿已自动保存", { exact: true }).waitFor();
        await page.reload({ waitUntil: "networkidle" });
        await expect(page.locator(".video-upload video")).toBeVisible();
        await expect(
          page.getByRole("textbox", { name: "内容标题" }),
        ).toHaveValue("QA 视频内容");
        await page.screenshot({
          path: path.join(out, "video.png"),
          fullPage: true,
        });
        await page
          .getByRole("button", { name: "模拟发布 2 个账号", exact: true })
          .click();
        await page
          .getByRole("button", { name: "确认模拟发布", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: "模拟发布结果" }),
        ).toBeVisible();
        await expect(
          page
            .locator(".publish-result")
            .getByText("模拟成功", { exact: true }),
        ).toHaveCount(2);
        await page
          .getByRole("button", { name: "继续编辑", exact: true })
          .click();
      },
    );
    await check(
      "Interrupted response survives reload and reuses one request id without duplicate history",
      async () => {
        let captured;
        await page.route("**/api/publish", async (route) => {
          captured = route.request().postDataJSON();
          const response = await route.fetch();
          await route.abort("connectionreset");
        });
        await page
          .getByRole("button", { name: "模拟发布 2 个账号", exact: true })
          .click();
        await page
          .getByRole("button", { name: "确认模拟发布", exact: true })
          .click();
        await expect(page.getByRole("alert")).toBeVisible();
        expect(
          await page.evaluate(
            () => JSON.parse(localStorage.getItem("square.pending")).requestId,
          ),
        ).toBe(captured.requestId);
        const count = (
          await (
            await page.request.get("http://127.0.0.1:5175/api/history")
          ).json()
        ).history.length;
        await page.unroute("**/api/publish");
        await page.reload({ waitUntil: "networkidle" });
        await expect(
          page.getByRole("dialog", { name: "确认模拟发布" }),
        ).toBeVisible();
        const retry = page.waitForRequest(
          (r) => r.url().endsWith("/api/publish") && r.method() === "POST",
        );
        await page
          .getByRole("button", { name: "重试本次提交", exact: true })
          .click();
        expect((await retry).postDataJSON().requestId).toBe(captured.requestId);
        await expect(
          page.getByRole("dialog", { name: "模拟发布结果" }),
        ).toBeVisible();
        expect(
          (
            await (
              await page.request.get("http://127.0.0.1:5175/api/history")
            ).json()
          ).history.length,
        ).toBe(count);
        expect(
          await page.evaluate(() => localStorage.getItem("square.pending")),
        ).toBeNull();
        await page
          .getByRole("button", { name: "继续编辑", exact: true })
          .click();
      },
    );
    await check(
      "Blank current draft remains blank after save and reload",
      async () => {
        await page
          .getByRole("button", { name: "新建内容", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "内容标题" })
          .fill("QA 需要清空");
        await page
          .getByRole("textbox", { name: "正文", exact: true })
          .fill("这段文字应被删除。");
        await page
          .getByRole("button", { name: "保存草稿", exact: true })
          .click();
        await page.getByRole("textbox", { name: "内容标题" }).fill("");
        await page.getByRole("textbox", { name: "正文", exact: true }).fill("");
        await page
          .getByRole("button", { name: "保存草稿", exact: true })
          .click();
        await page.getByText("草稿已自动保存", { exact: true }).waitFor();
        const id = await page.evaluate(
          () => JSON.parse(localStorage.getItem("square.active")).id,
        );
        await page.reload({ waitUntil: "networkidle" });
        await expect(
          page.getByRole("textbox", { name: "内容标题" }),
        ).toHaveValue("");
        await expect(
          page.getByRole("textbox", { name: "正文", exact: true }),
        ).toBeEmpty();
        const row = (
          await (
            await page.request.get("http://127.0.0.1:5175/api/drafts")
          ).json()
        ).drafts.find((d) => d.id === id);
        expect(row.title).toBe("");
        expect(row.body.trim()).toBe("");
      },
    );

    await check(
      "Mobile footer publishing buttons remain reachable above fixed navigation",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page
          .getByRole("textbox", { name: "内容标题" })
          .fill("QA 手机发布");
        await page
          .getByRole("textbox", { name: "正文", exact: true })
          .fill("手机上可操作的发布内容。");
        await page.getByRole("checkbox").nth(0).check();
        await page.getByRole("checkbox").nth(1).check();
        const publish = page.getByRole("button", {
          name: "模拟发布 2 个账号",
          exact: true,
        });
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight),
        );
        const box = await publish.boundingBox(),
          navigation = await page.locator(".sidebar").boundingBox();
        expect(box.y + box.height).toBeLessThanOrEqual(navigation.y);
        await page.screenshot({
          path: path.join(out, "mobile-publish-bottom.png"),
        });
        await publish.click();
        await expect(
          page.getByRole("dialog", { name: "确认模拟发布", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "返回编辑", exact: true })
          .click();
      },
    );
  } else {
    const nav = (label) =>
      page
        .getByRole("navigation", { name: "主要导航" })
        .getByRole("button", { name: label });
    await check(
      "Desktop has no viewport overflow and all avatars load",
      async () => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(1487);
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight),
        ).toBeLessThanOrEqual(1058);
        expect(
          await page
            .locator("img")
            .evaluateAll((imgs) =>
              imgs.every((i) => i.complete && i.naturalWidth > 0),
            ),
        ).toBe(true);
      },
    );
    await check("Account add/edit/local-only name and deletion", async () => {
      await nav("账号管理").click();
      await page
        .getByRole("button", { name: "添加账号", exact: true })
        .first()
        .click();
      await page.getByLabel("展示名称").fill("QA 临时账号");
      const secret = "QA_SQUARE_NOT_REAL_0123456789";
      await page.getByLabel("币安广场 OpenAPI Key").fill(secret);
      const saved = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/accounts") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "保存账号", exact: true }).click();
      expect(JSON.stringify(await (await saved).json())).not.toContain(secret);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page
        .getByRole("button", { name: "编辑 QA 临时账号", exact: true })
        .click();
      await page.getByLabel("展示名称").fill("QA 改名账号");
      await page.getByRole("button", { name: "保存账号", exact: true }).click();
      await expect(
        page.getByText("QA 改名账号", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "进入真实工作区" }).click();
      await expect(
        page.getByRole("button", { name: "真实工作区" }),
      ).toBeVisible();
      await expect(page.locator(".account-choice")).toHaveCount(1);
      await page.getByRole("button", { name: "真实工作区" }).click();
      await expect(
        page.getByRole("button", { name: "演示工作区" }),
      ).toBeVisible();
      await nav("账号管理").click();
      await page
        .getByRole("button", { name: "删除 QA 改名账号", exact: true })
        .click();
      await page.getByRole("button", { name: "确认删除", exact: true }).click();
      await expect(page.getByText("连接你的第一个广场账号")).toBeVisible();
      await page.screenshot({
        path: path.join(out, "accounts.png"),
        fullPage: true,
      });
      await nav("创作中心").click();
    });
    await check(
      "Editor emoji, topic and coin insertion and automatic draft recovery",
      async () => {
        await page
          .getByRole("textbox", { name: "内容标题" })
          .fill("QA 自动恢复草稿");
        const body = page.getByRole("textbox", { name: "正文", exact: true });
        await body.fill("这是关闭页面后仍能恢复的内容。");
        await body.press("End");
        await page.getByRole("button", { name: "表情", exact: true }).click();
        await page.getByRole("button", { name: "🚀", exact: true }).click();
        await expect(body).toContainText("🚀");
        await page.getByRole("button", { name: "标签", exact: true }).click();
        await page.getByRole("textbox", { name: "话题标签" }).fill("验收标签");
        await page
          .locator(".tag-pop")
          .getByRole("button", { name: "添加", exact: true })
          .click();
        await expect(page.locator(".tag-list")).toContainText("#验收标签");
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await page
          .getByRole("button", { name: "插入币种", exact: true })
          .click();
        await page.getByLabel("币种简称").fill("ETH");
        await page
          .getByRole("button", { name: "插入正文", exact: true })
          .click();
        await expect(body).toContainText("$ETH");
        await page.getByText("草稿已自动保存", { exact: true }).waitFor();
        const before = await body.innerText();
        await page.reload({ waitUntil: "networkidle" });
        await expect(
          page.getByRole("textbox", { name: "内容标题" }),
        ).toHaveValue("QA 自动恢复草稿");
        await expect(
          page.getByRole("textbox", { name: "正文", exact: true }),
        ).toHaveText(before);
        await expect(page.locator(".tag-list")).toContainText("#验收标签");
      },
    );
    await check(
      "Same K-line reinsertion and 2-account simulated publishing",
      async () => {
        await page.getByRole("button", { name: "K线", exact: true }).click();
        await page
          .getByRole("button", { name: "插入图表", exact: true })
          .click();
        await page
          .getByRole("button", { name: "模拟发布 2 个账号", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: "确认模拟发布", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "确认模拟发布", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: "模拟发布结果" }),
        ).toBeVisible();
        await expect(
          page
            .locator(".publish-result")
            .getByText("模拟成功", { exact: true }),
        ).toHaveCount(2);
        await page
          .getByRole("button", { name: "查看发布历史", exact: true })
          .click();
        await expect(page.locator(".history-row")).toHaveCount(1);
        await expect(page.locator(".history-row")).toContainText("演示发布");
        await page.screenshot({
          path: path.join(out, "history.png"),
          fullPage: true,
        });
      },
    );
    await check(
      "Draft box search, resume and independent draft preservation",
      async () => {
        await nav("草稿箱").click();
        await page.getByPlaceholder("搜索草稿内容").fill("QA 自动恢复");
        await expect(page.locator(".draft-row")).toHaveCount(1);
        await page
          .getByRole("button", { name: "继续编辑", exact: true })
          .click();
        await expect(
          page.getByRole("textbox", { name: "内容标题" }),
        ).toHaveValue("QA 自动恢复草稿");
        await page
          .getByRole("button", { name: "新建内容", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "内容标题" })
          .fill("QA 第二份草稿");
        await page
          .getByRole("textbox", { name: "正文", exact: true })
          .fill("独立保留的第二份内容。");
        await page
          .getByRole("button", { name: "保存草稿", exact: true })
          .click();
        await nav("草稿箱").click();
        await expect(page.locator(".draft-row")).toHaveCount(2);
        await page
          .locator(".draft-row")
          .filter({ hasText: "QA 自动恢复草稿" })
          .getByRole("button", { name: "继续编辑" })
          .click();
        await expect(
          page.getByRole("textbox", { name: "正文", exact: true }),
        ).toContainText("关闭页面后");
      },
    );
    await check(
      "Article draft preserves rich formatting and image cover",
      async () => {
        await page.getByRole("button", { name: "文章", exact: true }).click();
        await page
          .getByRole("button", { name: "保存并切换", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "文章标题" })
          .fill("QA 图文文章");
        const body = page.getByRole("textbox", { name: "正文", exact: true });
        await body.fill("需要保留的加粗文章内容。");
        await body.press("ControlOrMeta+A");
        await page
          .getByRole("button", { name: "加粗（草稿排版）", exact: true })
          .click();
        await expect(body.locator("b,strong")).toHaveCount(1);
        await page
          .locator("input[type=file]")
          .setInputFiles("public/assets/avatar-panda.png");
        await expect(page.locator(".media-tile")).toHaveCount(1);
        await page
          .getByRole("button", { name: "保存草稿", exact: true })
          .click();
        await page.reload({ waitUntil: "networkidle" });
        await expect(
          page.getByRole("textbox", { name: "文章标题" }),
        ).toHaveValue("QA 图文文章");
        await expect(
          page
            .getByRole("textbox", { name: "正文", exact: true })
            .locator("b,strong"),
        ).toHaveCount(1);
        await expect(page.locator(".media-tile img")).toBeVisible();
        await page
          .getByRole("button", { name: "模拟发布 2 个账号", exact: true })
          .click();
        await expect(
          page.getByRole("dialog").getByText(/当前 API 按纯文本发布/),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "返回编辑", exact: true })
          .click();
        await page.screenshot({
          path: path.join(out, "article.png"),
          fullPage: true,
        });
      },
    );
    await check(
      "Mobile compose, modal and navigation have no horizontal overflow",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: path.join(out, "mobile-article.png"),
          fullPage: true,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(390);
        await page.getByRole("button", { name: "标签", exact: true }).click();
        const box = await page.locator(".tag-pop").boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        await page.keyboard.press("Escape");
        await nav("账号管理").click();
        await page
          .getByRole("button", { name: "添加账号", exact: true })
          .first()
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        const modalBox = await page.getByRole("dialog").boundingBox();
        expect(modalBox.width).toBeLessThanOrEqual(390);
        await page.screenshot({
          path: path.join(out, "mobile-modal.png"),
          fullPage: true,
        });
        await page.keyboard.press("Escape");
        await nav("发布历史").click();
        await expect(page.locator(".history-row")).toHaveCount(1);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(390);
      },
    );

    await check(
      "Composer stays within 360, 768, 1024 and 1280 pixel viewports",
      async () => {
        await nav("创作中心").click();
        await page
          .getByRole("button", { name: "新建内容", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "内容标题" })
          .fill("响应式创作检查");
        await page
          .getByRole("textbox", { name: "正文", exact: true })
          .fill("在不同屏幕上，内容与操作都应清晰可达。");
        await page.getByRole("button", { name: "K线", exact: true }).click();
        await page
          .getByRole("button", { name: "插入图表", exact: true })
          .click();
        for (const [width, height] of [
          [360, 800],
          [768, 1024],
          [1024, 768],
          [1280, 800],
        ]) {
          await page.setViewportSize({ width, height });
          await page.locator(".chart-card").waitFor();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(width);
          if (width === 360 || width === 768)
            await page.screenshot({
              path: path.join(out, "responsive-" + width + ".png"),
              fullPage: true,
            });
        }
      },
    );
  }
  console.log(JSON.stringify({ checks, errors }));
  await fs.writeFile(
    path.join(
      out,
      process.argv.includes("--capture-only")
        ? "results-capture.json"
        : process.argv.includes("--extended")
          ? "results-extended.json"
          : "results.json",
    ),
    JSON.stringify({ checks, errors, dataDirectory }, null, 2),
  );
} catch (error) {
  await page.screenshot({
    path: path.join(out, "failure.png"),
    fullPage: true,
  });
  await fs.writeFile(
    path.join(out, "failure.json"),
    JSON.stringify({ message: error.message, checks, errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await vite.close();
  await new Promise((r) => api.server.close(r));
}
