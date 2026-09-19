import { normalizeDraft, isDemoPending } from "../shared/demo-cleanup.mjs";
export { normalizeDraft } from "../shared/demo-cleanup.mjs";
export async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("服务暂时不可用，请稍后重试。");
  }
  if (!response.ok) {
    const error = new Error(response.status === 401 ? "登录已失效，请刷新页面后重新登录。当前草稿仍保留在本浏览器。" : data.error || "操作失败，请重试。");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}
// randomUUID is restricted to secure contexts; IP + HTTP still supports
// cryptographically strong getRandomValues in modern browsers.
export function uid() {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const dateText = (date) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export const initialDraft = () => emptyDraft();
export const emptyDraft = (demo = false) => ({
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
      ? values.map(normalizeDraft).filter((d) => d?.id && d?.updatedAt)
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
  for (const d of [...first, ...second].map(normalizeDraft).filter(Boolean))
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
    if (isDemoPending(c)) { localStorage.removeItem("square.pending"); return null; }
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

// Retain a one-time recovery copy without clearing unrelated browser storage.
export function migrateBrowserWorkspace() {
  let current = null;
  try {
    current = JSON.parse(localStorage.getItem("square.active") || "null");
    const cached = JSON.parse(localStorage.getItem("square.drafts") || "[]");
    const pending = JSON.parse(localStorage.getItem("square.pending") || "null");
    const normalized = normalizeDraft(current);
    const drafts = Array.isArray(cached) ? cached.map(normalizeDraft).filter(Boolean) : [];
    const changed = JSON.stringify(normalized) !== JSON.stringify(current) ||
      JSON.stringify(drafts) !== JSON.stringify(cached) || isDemoPending(pending);
    if (changed) {
      if (!localStorage.getItem("square.before-demo-cleanup.v1"))
        localStorage.setItem("square.before-demo-cleanup.v1", JSON.stringify({ active: current, drafts: cached, pending }));
      if (normalized) localStorage.setItem("square.active", JSON.stringify(normalized));
      else localStorage.removeItem("square.active");
      localStorage.setItem("square.drafts", JSON.stringify(drafts));
      if (isDemoPending(pending)) localStorage.removeItem("square.pending");
    }
    return normalized;
  } catch {
    return normalizeDraft(current);
  }
}
