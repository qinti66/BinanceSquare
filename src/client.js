export async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("本地服务暂时不可用，请稍后重试。");
  }
  if (!response.ok) {
    const error = new Error(data.error || "操作失败，请重试。");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}
export const uid = () => crypto.randomUUID();
export const dateText = (date) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export const demoAccounts = [
  {
    id: "demo-main",
    name: "主账号",
    avatar: "/assets/avatar-mountain.png",
    demo: true,
  },
  {
    id: "demo-market",
    name: "行情观察",
    avatar: "/assets/avatar-panda.png",
    demo: true,
  },
  {
    id: "demo-notes",
    name: "交易笔记",
    avatar: "/assets/avatar-sunset.png",
    demo: true,
  },
];
export const initialDraft = () => ({
  id: uid(),
  type: "post",
  title: "今天的市场观察",
  body: "市场的每一次波动，都值得认真记录。\n分享我的观察，也期待听到你的观点。",
  tags: ["BTC", "市场观察"],
  chart: { symbol: "BTCUSDT", interval: "4h" },
  media: [],
  selectedAccounts: ["demo-main", "demo-market"],
  demo: true,
  updatedAt: new Date().toISOString(),
});
export const emptyDraft = (demo = true) => ({
  id: uid(),
  type: "post",
  title: "",
  body: "",
  tags: [],
  chart: null,
  media: [],
  selectedAccounts: [],
  demo,
  updatedAt: new Date().toISOString(),
});
export const hasContent = (draft) =>
  Boolean(
    draft.title?.trim() ||
      draft.body?.trim() ||
      draft.media?.length ||
      draft.chart ||
      draft.tags?.length,
  );
export function textBody(draft) {
  return [
    draft.type === "article" ? "" : draft.title,
    draft.body,
    draft.tags?.map((t) => "#" + t).join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const allowed = new Set([
    "B",
    "STRONG",
    "I",
    "EM",
    "U",
    "P",
    "DIV",
    "BR",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
  ]);
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT"].includes(el.tagName)) {
        el.remove();
        continue;
      }
      walk(el);
      if (!allowed.has(el.tagName)) el.replaceWith(...el.childNodes);
      else for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function localDrafts() {
  try {
    const values = JSON.parse(localStorage.getItem("square.drafts") || "[]");
    return Array.isArray(values)
      ? values.filter((d) => d?.id && d?.updatedAt)
      : [];
  } catch {
    return [];
  }
}
export function backupDraft(draft) {
  if (!hasContent(draft) && !localDrafts().some((d) => d.id === draft.id))
    return true;
  try {
    localStorage.setItem(
      "square.drafts",
      JSON.stringify(mergeDrafts([draft], localDrafts())),
    );
    return true;
  } catch {
    return false;
  }
}
export function mergeDrafts(first, second) {
  const map = new Map();
  for (const d of [...first, ...second])
    if (!map.has(d.id) || map.get(d.id).updatedAt < d.updatedAt)
      map.set(d.id, d);
  return [...map.values()];
}
export function forgetLocalDraft(id) {
  try {
    localStorage.setItem(
      "square.drafts",
      JSON.stringify(localDrafts().filter((d) => d.id !== id)),
    );
  } catch {}
}

export function readPending() {
  try {
    const c = JSON.parse(localStorage.getItem("square.pending") || "null");
    return c?.requestId && c?.payload && c?.draft && Array.isArray(c?.accounts)
      ? {
          ...c,
          error: "上次提交尚未确认结果，请查询同一次提交。",
          restored: true,
        }
      : null;
  } catch {
    return null;
  }
}
