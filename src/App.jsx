import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  PencilSimpleLine,
  FileText,
  ClockCounterClockwise,
  UsersThree,
  CaretRight,
  Check,
  Plus,
  X,
  Smiley,
  ImageSquare,
  Hash,
  ChartBar,
  DotsThree,
  TextB,
  TextItalic,
  ListBullets,
  ListNumbers,
  LinkSimple,
  VideoCamera,
  PaperPlaneTilt,
  FloppyDisk,
  MagnifyingGlass,
  Trash,
  PencilSimple,
  ArrowSquareOut,
  CheckCircle,
  WarningCircle,
  CircleNotch,
  ShieldCheck,
  SquaresFour,
  DownloadSimple,
  Info,
  UploadSimple,
} from "@phosphor-icons/react";
import {
  api,
  uid,
  dateText,
  initialDraft,
  emptyDraft,
  hasContent,
  textBody,
  cleanHtml,
  localDrafts,
  backupDraft,
  mergeDrafts,
  forgetLocalDraft,
  readPending,
  migrateBrowserWorkspace,
} from "./client";
import CandleChart from "./Chart";
import { uploadFile, extractVideoCover, clipboardImages } from "./media";
const types = { post: "帖子", article: "文章", video: "视频" };
const emojis = [
  "😀",
  "😊",
  "😎",
  "🤔",
  "🥳",
  "🔥",
  "🚀",
  "💎",
  "📈",
  "📉",
  "💰",
  "✅",
  "🙌",
  "👍",
  "❤️",
  "👀",
  "🎯",
  "⚡",
  "💡",
  "🌟",
  "💪",
  "🙏",
  "🧠",
  "☕",
];
function Avatar({ account, size = 42 }) {
  return account?.avatar?.startsWith("/") ? (
    <img
      className="avatar"
      src={account.avatar}
      width={size}
      height={size}
      alt=""
    />
  ) : (
    <span
      className="avatar monogram"
      style={{
        width: size,
        height: size,
        background: account?.color || "#60512a",
      }}
    >
      {account?.name?.slice(0, 1) || "S"}
    </span>
  );
}
function IB({ label, children, ...p }) {
  return (
    <button
      type="button"
      className="icon-button"
      title={label}
      aria-label={label}
      {...p}
    >
      {children}
    </button>
  );
}
function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.focus();
    const f = (e) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const els = ref.current.querySelectorAll(
          'button:not(:disabled),input,textarea,select,[tabindex="0"]',
        );
        const a = els[0],
          b = els[els.length - 1];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b?.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a?.focus();
        }
      }
    };
    document.addEventListener("keydown", f);
    return () => {
      document.removeEventListener("keydown", f);
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h2>{title}</h2>
          <IB label="关闭" onClick={onClose}>
            <X size={22} />
          </IB>
        </header>
        {children}
      </section>
    </div>
  );
}
function Editor({ draft, onChange, editorRef, onImagePaste }) {
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = draft.html ? cleanHtml(draft.html) : "";
      if (!draft.html) editorRef.current.innerText = draft.body || "";
    }
  }, [draft.id]);
  return (
    <div
      className="writing-body"
      role="textbox"
      aria-label="正文"
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      ref={editorRef}
      data-placeholder={draft.type === "video"
        ? "分享你的市场观察，让每一次思考被看见…"
        : "分享你的市场观察，也可直接粘贴图片（Ctrl+V / ⌘V）…"}
      onInput={(e) =>
        onChange({
          body: e.currentTarget.innerText,
          html: cleanHtml(e.currentTarget.innerHTML),
        })
      }
      onPaste={(e) => {
        e.preventDefault();
        const images = clipboardImages(e.clipboardData);
        if (images.length) onImagePaste(images);
        const text = e.clipboardData.getData("text/plain");
        if (text) document.execCommand("insertText", false, text);
      }}
    />
  );
}
export function App() {
  const [draft, setDraft] = useState(() => {
    try {
      const d = migrateBrowserWorkspace();
      if (d?.id && types[d.type]) return { ...emptyDraft(), ...d };
    } catch {}
    return initialDraft();
  });
  const [page, setPage] = useState("compose"),
    [accounts, setAccounts] = useState([]),
    [drafts, setDrafts] = useState(localDrafts),
    [history, setHistory] = useState([]);
  const [connectionTests, setConnectionTests] = useState({});
  const connectionLocks = useRef(new Set());
  const [saveStatus, setSaveStatus] = useState("尚未输入内容"),
    [saveError, setSaveError] = useState(""),
    [serviceError, setServiceError] = useState("");
  const [toast, setToast] = useState(""),
    [popup, setPopup] = useState(""),
    [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [form, setForm] = useState({ name: "", apiKey: "" }),
    [formError, setFormError] = useState(""),
    [tagText, setTagText] = useState(""),
    [chartForm, setChartForm] = useState({ symbol: "BTCUSDT", interval: "4h" });
  const [confirmation, setConfirmation] = useState(readPending),
    [result, setResult] = useState(null),
    [uploading, setUploading] = useState(false);
  const editor = useRef(null),
    selection = useRef(null),
    chartImage = useRef(null),
    fileInput = useRef(null),
    active = useRef(draft),
    timer = useRef(null),
    toastTimer = useRef(null),
    uploadLock = useRef(false),
    deletedIds = useRef(new Set());
  const notify = useCallback((m) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }, []);
  const update = useCallback(
    (p) =>
      setDraft((d) => ({
        ...d,
        ...p,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(d.updatedAt || 0) + 1 || 0),
        ).toISOString(),
      })),
    [],
  );
  const refresh = useCallback(async () => {
    try {
      const [a, d, h] = await Promise.all([
        api("/accounts"),
        api("/drafts"),
        api("/history"),
      ]);
      setAccounts(a.accounts || []);
      setDrafts(mergeDrafts(d.drafts || [], localDrafts()));
      setHistory((h.history || []).filter((entry) => entry.demo !== true));
      setServiceError("");
    } catch (e) {
      setServiceError(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
    return () => clearTimeout(toastTimer.current);
  }, []);
  const persist = useCallback(
    async (d, manual = false) => {
      if (!hasContent(d) && !localDrafts().some((x) => x.id === d.id)) {
        setSaveStatus("尚未输入内容");
        if (manual) notify("填写内容后即可保存草稿");
        return true;
      }
      const backed = backupDraft(d);
      if (backed) setDrafts((ds) => mergeDrafts([d], ds));
      try {
        const saved = await api("/drafts/" + d.id, {
          method: "PUT",
          body: JSON.stringify(d),
        });
        if (deletedIds.current.has(d.id)) return true;
        setDrafts((ds) => mergeDrafts([saved.draft || d], ds));
        if (
          active.current.id === d.id &&
          active.current.updatedAt === d.updatedAt
        ) {
          setSaveStatus("草稿已自动保存");
          setSaveError("");
        }
        if (manual) notify("草稿已保存，可在草稿箱继续编辑");
        return true;
      } catch (e) {
        if (
          active.current.id === d.id &&
          active.current.updatedAt === d.updatedAt
        ) {
          setSaveStatus("已保存到此浏览器");
          setSaveError("服务端未同步：" + e.message);
        }
        if (manual)
          notify(
            backed
              ? "草稿已保存在此浏览器，服务同步失败"
              : "保存失败，请先导出草稿",
          );
        return backed;
      }
    },
    [notify],
  );
  useEffect(() => {
    active.current = draft;
    setSaveStatus(hasContent(draft) || localDrafts().some((x) => x.id === draft.id) ? "正在保存" : "尚未输入内容");
    try {
      localStorage.setItem("square.active", JSON.stringify(draft));
      if (!backupDraft(draft)) throw Error("storage full");
      setDrafts((ds) =>
        hasContent(draft) || localDrafts().some((x) => x.id === draft.id)
          ? mergeDrafts([draft], ds)
          : ds,
      );
      setSaveError("");
    } catch {
      setSaveError("浏览器存储已满，请立即保存到服务端。");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(draft), 650);
    return () => clearTimeout(timer.current);
  }, [draft, persist]);
  useEffect(() => {
    const f = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        persist(active.current, true);
      }
      if (e.key === "Escape") setPopup("");
    };
    const save = () => {
      try {
        localStorage.setItem("square.active", JSON.stringify(active.current));
      } catch {}
    };
    window.addEventListener("keydown", f);
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("keydown", f);
      window.removeEventListener("pagehide", save);
    };
  }, [persist]);
  const visibleAccounts = accounts,
    selected = visibleAccounts.filter((a) =>
      draft.selectedAccounts.includes(a.id),
    ),
    first = selected[0] || visibleAccounts[0],
    words = textBody(draft).length,
    limit = draft.type === "article" ? 80000 : 2100;
  const nav = (name) => {
    setPage(name);
    setSearch("");
    setFilter("all");
    setPopup("");
    if (name !== "compose") refresh();
  };
  const remember = () => {
    const s = window.getSelection();
    if (s.rangeCount && editor.current?.contains(s.anchorNode))
      selection.current = s.getRangeAt(0).cloneRange();
  };
  const command = (c, value) => {
    editor.current?.focus();
    if (selection.current) {
      try {
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(selection.current);
      } catch {}
    }
    document.execCommand(c, false, value);
    if (editor.current)
      update({
        body: editor.current.innerText,
        html: cleanHtml(editor.current.innerHTML),
      });
  };
  const insert = (t) => {
    command("insertText", t);
    setPopup("");
  };
  const newDraft = async () => {
    if (uploading) return notify("媒体正在上传，请稍后新建");
    clearTimeout(timer.current);
    if (!(await persist(draft))) return notify("保存失败，请先导出草稿");
    if (active.current.updatedAt !== draft.updatedAt)
      return notify("内容刚刚更新，请再次点击新建以保存最新版本");
    selection.current = null;
    setDraft(emptyDraft());
    nav("compose");
  };
  const resume = async (d) => {
    if (d.id === active.current.id) {
      nav("compose");
      return;
    }
    if (uploading) return notify("媒体正在上传，请稍后切换");
    clearTimeout(timer.current);
    if (!(await persist(draft))) return notify("保存失败，请先导出草稿");
    if (active.current.updatedAt !== draft.updatedAt)
      return notify("内容刚刚更新，请再次点击以保存最新版本");
    const latest =
      mergeDrafts([d], localDrafts()).find((x) => x.id === d.id) || d;
    selection.current = null;
    setDraft({ ...emptyDraft(), ...latest });
    nav("compose");
    notify("已恢复草稿");
  };
  const switchType = (type) => {
    if (uploading) return notify("媒体正在上传，请稍后切换");
    if (type === draft.type) return;
    if (draft.media.length || draft.chart) setModal({ kind: "switch", type });
    else update({ type });
  };
  const addTag = (t) => {
    t = t.trim().replace(/^#+/, "").replace(/\s+/g, "");
    if (!t) return;
    if (draft.tags.includes(t)) {
      notify("该标签已添加");
      return;
    }
    update({ tags: [...draft.tags, t] });
    setTagText("");
    setPopup("");
  };
  const openAccount = (a) => {
    setForm({ name: a?.name || "", apiKey: "" });
    setFormError("");
    setModal({ kind: "account", account: a });
  };
  const saveAccount = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      const data = { name: form.name.trim() };
      if (form.apiKey.trim()) data.apiKey = form.apiKey.trim();
      if (!data.name) throw Error("请填写展示名称");
      if (!modal.account && !data.apiKey)
        throw Error("请填写币安广场 OpenAPI Key");
      const saved = await api("/accounts" + (modal.account ? "/" + modal.account.id : ""), {
        method: modal.account ? "PATCH" : "POST",
        body: JSON.stringify(data),
      });
      setConnectionTests((previous) => {
        const next = { ...previous };
        delete next[saved.account.id];
        return next;
      });
      setForm({ name: "", apiKey: "" });
      setModal(null);
      await refresh();
      notify("账号已保存，可点击测试连接检查服务器网络");
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const testConnection = async (account) => {
    if (connectionLocks.current.has(account.id)) return;
    connectionLocks.current.add(account.id);
    setConnectionTests((previous) => ({ ...previous, [account.id]: { loading: true } }));
    setModal({ kind: "connection-test", account });
    try {
      const response = await api(`/accounts/${account.id}/test`, {
        method: "POST", body: "{}",
      });
      setConnectionTests((previous) => ({ ...previous, [account.id]: response.test }));
    } catch (error) {
      setConnectionTests((previous) => ({ ...previous, [account.id]: {
        status: "error", title: "测试未完成", message: error.message,
        code: error.code || "LOCAL_CONNECTION_ERROR", keyStatus: "unverified",
        checkedAt: new Date().toISOString(),
      } }));
    } finally {
      connectionLocks.current.delete(account.id);
    }
  };
  const uploadFiles = async (files) => {
    if (uploadLock.current) {
      return notify("媒体正在上传，请稍候");
    }
    if (!files.length) return;
    uploadLock.current = true;
    setUploading(true);
    try {
      if (draft.type === "video") {
        const file = files[0];
        if (!file.type.startsWith("video/")) throw Error("请选择视频文件");
        if (file.size > 100 * 1024 * 1024) throw Error("视频不能超过 100 MB");
        const cover = await extractVideoCover(file);
        if (cover.duration > 86400) throw Error("视频时长不能超过 24 小时");
        const [m, c] = await Promise.all([
          uploadFile(file),
          uploadFile(cover.file),
        ]);
        setDraft((current) =>
          current.id === draft.id && current.type === "video"
            ? {
                ...current,
                media: [
                  {
                    ...m,
                    coverMediaId: c.id,
                    coverUrl: c.url,
                    duration: cover.duration,
                  },
                ],
                updatedAt: new Date(
                  Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
                ).toISOString(),
              }
            : current,
        );
      } else {
        const cap = draft.type === "article" ? 1 : 4 - (draft.chart ? 1 : 0);
        if (draft.media.length + files.length > cap)
          throw Error("当前最多可添加 " + cap + " 张图片（K 线占用一张）");
        for (const f of files) {
          if (!f.type.startsWith("image/")) throw Error("请选择图片文件");
          if (f.size > 10 * 1024 * 1024) throw Error("图片不能超过 10 MB");
        }
        const ms = [];
        for (const f of files) {
          ms.push(await uploadFile(f));
        }
        setDraft((current) =>
          current.id === draft.id && current.type === draft.type
            ? {
                ...current,
                media: [...current.media, ...ms],
                updatedAt: new Date(
                  Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
                ).toISOString(),
              }
            : current,
        );
      }
      notify("媒体已保存");
    } catch (e) {
      notify(e.message);
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  };
  const prepare = () => {
    const pending = readPending();
    if (pending) {
      setConfirmation(pending);
      return;
    }
    if (!selected.length) return notify("请先选择发布账号");
    if (!draft.body.trim() && !draft.title.trim() && !draft.media.length)
      return notify("请先填写内容");
    if (draft.type !== "video" && !textBody(draft).trim())
      return notify("请填写正文后再发布");
    if (words > limit) return notify("内容超出字数限制");
    if (draft.type === "article" && !draft.title.trim())
      return notify("文章需要标题");
    if (draft.type === "video" && !draft.media.length)
      return notify("请先上传视频");
    if (draft.chart && !chartImage.current)
      return notify("K 线尚未就绪，请稍后重试或移除图表");
    setConfirmation({
      draft: structuredClone(draft),
      accounts: structuredClone(selected),
      requestId: uid(),
      error: "",
      payload: null,
    });
  };
  const publish = async () => {
    setBusy(true);
    try {
      let payload = confirmation.payload;
      if (!payload) {
        const d = confirmation.draft;
        let mediaIds = d.media.map((m) => m.id);
        if (d.chart) {
          const m = await uploadFile(
            new File([chartImage.current], "kline-" + d.chart.symbol + ".png", {
              type: "image/png",
            }),
          );
          mediaIds.push(m.id);
        }
        const m = d.media[0];
        payload = {
          requestId: confirmation.requestId,
          accountIds: confirmation.accounts.map((a) => a.id),
          type: d.type,
          title: d.title,
          body: textBody(d),
          html: d.html || "",
          mediaIds,
          coverMediaId: m?.coverMediaId,
          duration: m?.duration,
          demo: false,
        };
        setConfirmation((c) => (c ? { ...c, payload } : c));
      }
      if (payload.demo !== false) throw Error("旧版测试提交已取消，请返回编辑并重新确认发布。");
      localStorage.setItem(
        "square.pending",
        JSON.stringify({ ...confirmation, payload }),
      );
      const r = await api("/publish", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (!r.results || r.results.some((x) => x.status === "pending"))
        throw Error("提交仍在处理中，请稍后重试查询同一次提交");
      localStorage.removeItem("square.pending");
      setResult({ ...r, accounts: confirmation.accounts });
      setConfirmation(null);
      refresh();
      notify("已收到发布结果");
    } catch (e) {
      const rejected = [400, 401, 403, 404, 413, 415, 422].includes(e.status);
      if (rejected) localStorage.removeItem("square.pending");
      setConfirmation((c) =>
        c
          ? {
              ...c,
              payload: rejected ? null : c.payload,
              error: rejected
                ? "请求未受理，请返回编辑修正：" + e.message
                : e.message,
            }
          : c,
      );
    } finally {
      setBusy(false);
    }
  };
  const exportDraft = (d) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }),
    );
    a.download = (d.title || "未命名草稿") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const onChartImage = useCallback((blob) => {
    chartImage.current = blob;
  }, []);
  const deleteItem = async () => {
    try {
      if (modal.kind === "delete-account") {
        await api("/accounts/" + modal.account.id, { method: "DELETE" });
        update({
          selectedAccounts: draft.selectedAccounts.filter(
            (id) => id !== modal.account.id,
          ),
        });
      } else {
        clearTimeout(timer.current);
        deletedIds.current.add(modal.draft.id);
        await api("/drafts/" + modal.draft.id, { method: "DELETE" });
        forgetLocalDraft(modal.draft.id);
        if (draft.id === modal.draft.id) setDraft(emptyDraft());
      }
      setModal(null);
      await refresh();
      notify("已删除");
    } catch (e) {
      if (modal?.draft) deletedIds.current.delete(modal.draft.id);
      notify(e.message);
    }
  };
  const ds = drafts
    .filter(
      (d) =>
        (filter === "all" || d.type === filter) &&
        ((d.title || "") + " " + (d.body || ""))
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const hs = history.filter(
    (h) =>
      h.demo !== true && (filter === "all" || h.type === filter) &&
      JSON.stringify([h.title, h.body, h.results?.map((r) => r.accountName)])
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const statusText = (s) =>
    ({
      success: "发布成功",
      failed: "发布失败",
      uncertain: "已提交，待核实",
      pending: "处理中",
    })[s] || s;
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            nav("compose");
          }}
        >
          <img className="brand-mark" src="/assets/brand-mark.png" alt="" />
          <div>
            <strong>墨金创作台</strong>
            <span>Square Studio</span>
            <small>广场矩阵工作台</small>
          </div>
        </a>
        <div className="workspace-switch live">
          <span className="status-dot" />
          创作工作台
        </div>
        <nav aria-label="主要导航">
          {[
            ["compose", PencilSimpleLine, "创作中心"],
            ["drafts", FileText, "草稿箱"],
            ["history", ClockCounterClockwise, "发布历史"],
            ["accounts", UsersThree, "账号管理"],
          ].map(([id, Icon, title]) => (
            <button
              className={"nav-item " + (page === id ? "active" : "")}
              key={id}
              onClick={() => nav(id)}
            >
              <Icon size={25} />
              <span>{title}</span>
              {id === "drafts" && drafts.length > 0 && (
                <small>{drafts.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <ShieldCheck size={19} />
            <span>
              灵感随时记录<small>草稿自动保存，创作安心继续</small>
            </span>
          </div>
          <div className="profile">
            <Avatar account={{ name: "我的工作台", color: "#343539" }} size={36} />
            <div>
              <strong>我的工作台</strong>
              <small>专注创作 · 长期主义</small>
            </div>
            <CaretRight size={15} />
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="page-header">
          <div>
            <h1>
              {
                {
                  compose: "创作中心",
                  drafts: "草稿箱",
                  history: "发布历史",
                  accounts: "账号管理",
                }[page]
              }
            </h1>
            <p>
              {
                {
                  compose: "把灵感，发布到你的每一个阵地。",
                  drafts: "每一份未完成的灵感，都在这里等你。",
                  history: "每一次发布，都有迹可循。",
                  accounts: "一个工作台，管理你的内容矩阵。",
                }[page]
              }
            </p>
          </div>
          <div className="header-right">
            <span>
              {new Date().toLocaleDateString("zh-CN", {
                year: "numeric",
                month: "long",
                day: "numeric",
                weekday: "long",
              })}
            </span>
            <button
              className={page === "compose" ? "subtle-button" : "primary"}
              onClick={() => (page === "accounts" ? openAccount() : newDraft())}
            >
              <Plus size={17} />
              {page === "accounts" ? "添加账号" : "新建内容"}
            </button>
          </div>
        </header>
        {serviceError && (
          <div className="service-banner">
            <WarningCircle size={18} />
            <span>服务连接失败，当前编辑保存在此浏览器。</span>
            <button onClick={refresh}>重试</button>
          </div>
        )}
        {page === "compose" && (
          <div className="compose-grid">
            <section className="editor-panel" aria-label="内容编辑器">
              <div className="type-tabs">
                {[
                  ["post", FileText],
                  ["article", FileText],
                  ["video", VideoCamera],
                ].map(([t, I]) => (
                  <button
                    className={draft.type === t ? "selected" : ""}
                    key={t}
                    onClick={() => switchType(t)}
                  >
                    <I size={22} />
                    {types[t]}
                  </button>
                ))}
              </div>
              <div className="format-toolbar" onMouseDown={remember}>
                {[
                  ["bold", TextB, "加粗"],
                  ["italic", TextItalic, "斜体"],
                  ["insertUnorderedList", ListBullets, "无序列表"],
                  ["insertOrderedList", ListNumbers, "有序列表"],
                ].map(([c, I, t], i) => (
                  <React.Fragment key={c}>
                    {i === 2 && <span className="separator" />}
                    <IB
                      label={t + "（草稿排版）"}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => command(c)}
                    >
                      <I size={22} />
                    </IB>
                  </React.Fragment>
                ))}
                <span className="separator" />
                <IB label="插入链接" onClick={() => setModal({ kind: "link" })}>
                  <LinkSimple size={22} />
                </IB>
                <span className="format-note">排版保存在草稿中</span>
              </div>
              <div className="editor-content">
                <input
                  className="title-input"
                  aria-label={
                    draft.type === "article" ? "文章标题" : "内容标题"
                  }
                  placeholder={
                    draft.type === "article"
                      ? "给文章一个好标题"
                      : "写下今天的主题…"
                  }
                  value={draft.title}
                  maxLength={100}
                  onChange={(e) => update({ title: e.target.value })}
                />
                {draft.type === "video" && (
                  <div className="video-upload">
                    {draft.media[0] ? (
                      <>
                        <video
                          controls
                          src={draft.media[0].url}
                          poster={draft.media[0].coverUrl}
                        />
                        <button
                          className="video-remove"
                          onClick={() => update({ media: [] })}
                        >
                          <X size={17} />
                          移除视频
                        </button>
                      </>
                    ) : (
                      <button
                        className="upload-area"
                        disabled={uploading}
                        onClick={() => fileInput.current.click()}
                      >
                        <UploadSimple size={38} />
                        <strong>上传你的视频</strong>
                        <span>选择视频文件，自动生成封面</span>
                        <small>MP4、WebM、MOV · 最大 100 MB</small>
                      </button>
                    )}
                  </div>
                )}
                <Editor
                  draft={draft}
                  onChange={update}
                  editorRef={editor}
                  onImagePaste={(files) => {
                    if (draft.type === "video") {
                      notify("视频内容不支持粘贴图片，请切换到帖子或文章");
                      return;
                    }
                    uploadFiles(files);
                  }}
                />
                <div className="tag-list">
                  {draft.tags.map((t) => (
                    <button
                      className="tag"
                      key={t}
                      title="点击移除标签"
                      onClick={() =>
                        update({ tags: draft.tags.filter((x) => x !== t) })
                      }
                    >
                      #{t}
                      <X size={12} />
                    </button>
                  ))}
                </div>
                {draft.chart && draft.type === "post" && (
                  <CandleChart
                    key={draft.chart.symbol + draft.chart.interval}
                    symbol={draft.chart.symbol}
                    interval={draft.chart.interval}
                    onImage={onChartImage}
                    onRemove={() => {
                      chartImage.current = null;
                      update({ chart: null });
                    }}
                  />
                )}
                {draft.type !== "video" && draft.media.length > 0 && (
                  <div className="media-grid">
                    {draft.media.map((m) => (
                      <div className="media-tile" key={m.id}>
                        <img src={m.url} alt={m.name} />
                        <IB
                          label={"移除 " + m.name}
                          onClick={() =>
                            update({
                              media: draft.media.filter((x) => x.id !== m.id),
                            })
                          }
                        >
                          <X size={16} />
                        </IB>
                        {draft.type === "article" && <span>文章封面</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <footer className="editor-footer">
                <div className="insert-toolbar" onMouseDown={remember}>
                  <div className="popover-anchor">
                    <button
                      className="tool"
                      onClick={() => setPopup(popup === "emoji" ? "" : "emoji")}
                    >
                      <Smiley size={24} />
                      <span>表情</span>
                    </button>
                    {popup === "emoji" && (
                      <div className="popover emoji-pop">
                        <div className="popover-label">
                          添加表情
                          <IB label="关闭表情" onClick={() => setPopup("")}>
                            <X size={16} />
                          </IB>
                        </div>
                        <div>
                          {emojis.map((e) => (
                            <button key={e} onClick={() => insert(e)}>
                              {e}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    className="tool"
                    disabled={uploading}
                    title={draft.type === "video" ? "选择视频文件" : "选择图片文件，或在正文中直接粘贴图片（Ctrl+V / ⌘V）"}
                    onClick={() => fileInput.current.click()}
                  >
                    <ImageSquare size={24} />
                    <span>
                      {uploading
                        ? "上传中"
                        : draft.type === "video"
                          ? "视频"
                          : draft.type === "article"
                            ? "封面"
                            : "图片"}
                    </span>
                  </button>
                  <div className="popover-anchor">
                    <button
                      className="tool"
                      onClick={() => setPopup(popup === "tags" ? "" : "tags")}
                    >
                      <Hash size={24} />
                      <span>标签</span>
                    </button>
                    {popup === "tags" && (
                      <div className="popover tag-pop">
                        <strong>添加话题标签</strong>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            addTag(tagText);
                          }}
                        >
                          <input
                            autoFocus
                            placeholder="输入标签，不需要 #"
                            aria-label="话题标签"
                            value={tagText}
                            onChange={(e) => setTagText(e.target.value)}
                            maxLength={50}
                          />
                          <button className="primary small">添加</button>
                        </form>
                        <small>常用话题</small>
                        <div className="suggested-tags">
                          {[
                            "BTC",
                            "ETH",
                            "市场观察",
                            "加密知识",
                            "交易日记",
                          ].map((t) => (
                            <button key={t} onClick={() => addTag(t)}>
                              #{t}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  {draft.type === "post" && (
                    <button
                      className="tool"
                      onClick={() => {
                        setChartForm(
                          draft.chart || { symbol: "BTCUSDT", interval: "4h" },
                        );
                        setModal({ kind: "chart" });
                      }}
                    >
                      <ChartBar size={24} />
                      <span>K线</span>
                    </button>
                  )}
                  <div className="popover-anchor">
                    <button
                      className="tool"
                      onClick={() => setPopup(popup === "more" ? "" : "more")}
                    >
                      <DotsThree size={26} />
                      <span>更多</span>
                    </button>
                    {popup === "more" && (
                      <div className="popover menu-pop">
                        <button
                          onClick={() => {
                            setPopup("");
                            setModal({ kind: "coin" });
                          }}
                        >
                          <Hash size={18} />
                          插入币种
                        </button>
                        <button
                          onClick={() => {
                            exportDraft(draft);
                            setPopup("");
                          }}
                        >
                          <DownloadSimple size={18} />
                          导出草稿
                        </button>
                        <button
                          onClick={() => {
                            setPopup("");
                            setModal({ kind: "capabilities" });
                          }}
                        >
                          <Info size={18} />
                          发布能力说明
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="save-status">
                  <span
                    className={saveError ? "warning" : ""}
                    title={saveError}
                  >
                    <CheckCircle size={14} />
                    {saveStatus}
                  </span>
                  <span className={words > limit ? "over-limit" : ""}>
                    {words.toLocaleString()} / {limit.toLocaleString()}
                  </span>
                </div>
              </footer>
              {saveError && <div className="inline-warning">{saveError}</div>}
            </section>
            <aside className="publish-panel">
              <div className="accounts-heading">
                <h2>发布到</h2>
                <button className="text-button" onClick={() => nav("accounts")}>
                  管理账号
                </button>
              </div>
              <div className="selection-description">
                <span>已选 {selected.length} 个账号</span>
                {visibleAccounts.length > 1 && (
                  <button
                    className="muted-link"
                    onClick={() =>
                      update({
                        selectedAccounts:
                          selected.length === visibleAccounts.length
                            ? []
                            : visibleAccounts.map((a) => a.id),
                      })
                    }
                  >
                    {selected.length === visibleAccounts.length
                      ? "取消全选"
                      : "全选"}
                  </button>
                )}
              </div>
              <div className="account-choices">
                {visibleAccounts.map((a) => (
                  <label className="account-choice" key={a.id}>
                    <input
                      type="checkbox"
                      checked={draft.selectedAccounts.includes(a.id)}
                      onChange={() =>
                        update({
                          selectedAccounts: draft.selectedAccounts.includes(
                            a.id,
                          )
                            ? draft.selectedAccounts.filter((x) => x !== a.id)
                            : [...draft.selectedAccounts, a.id],
                        })
                      }
                    />
                    <Avatar account={a} size={46} />
                    <span>
                      <strong>{a.name}</strong>
                      <small>密钥已配置</small>
                    </span>
                  </label>
                ))}
                {!visibleAccounts.length && (
                  <button
                    className="empty-accounts"
                    onClick={() => nav("accounts")}
                  >
                    <Plus size={24} />
                    添加第一个发布账号
                  </button>
                )}
              </div>
              <div className="preview-section">
                <div className="preview-heading">
                  <h2>发布预览</h2>
                  <span>{types[draft.type]}</span>
                </div>
                <div className="preview-author">
                  <Avatar account={first} size={44} />
                  <div>
                    <strong>{first?.name || "选择发布账号"}</strong>
                    <small>内容预览</small>
                  </div>
                </div>
                <div className="preview-body">
                  {draft.title && (
                    <p
                      className={
                        draft.type === "article" ? "preview-title" : ""
                      }
                    >
                      {draft.title}
                    </p>
                  )}
                  <p className="preview-copy">
                    {draft.body || "你的内容将在这里实时预览…"}
                  </p>
                  <p className="preview-tags">
                    {draft.tags.map((t) => "#" + t).join("  ")}
                  </p>
                  {draft.media[0] && (
                    <div className="preview-media">
                      {draft.type === "video" ? (
                        <video
                          controls
                          src={draft.media[0].url}
                          poster={draft.media[0].coverUrl}
                        />
                      ) : (
                        <img src={draft.media[0].url} alt="发布图片预览" />
                      )}
                    </div>
                  )}
                  {draft.chart && (
                    <div className="chart-attachment">
                      <ChartBar size={17} />
                      {draft.chart.symbol.replace("USDT", "/USDT")} ·
                      K线图片附件
                    </div>
                  )}
                </div>
              </div>
              <div className="publish-actions">
                <div>
                  <button
                    className="secondary"
                    onClick={() => persist(draft, true)}
                  >
                    <FloppyDisk size={18} />
                    保存草稿
                  </button>
                  <button
                    className="primary"
                    disabled={uploading || busy || !selected.length}
                    onClick={prepare}
                  >
                    <PaperPlaneTilt size={18} />
                    发布到 {selected.length} 个账号
                  </button>
                </div>
                <p>
                  内容将分别发布到所选账号的币安广场
                </p>
              </div>
            </aside>
          </div>
        )}

        {page === "accounts" && (
          <section className="collection-page">
            <div className="info-strip">
              <ShieldCheck size={23} />
              <div>
                <strong>你的账号，由你掌控</strong>
                <p>
                  展示名称仅在本工作台使用。请使用币安广场 OpenAPI
                  Key，密钥在服务端加密保存。
                </p>
              </div>
              <a
                href="https://www.binance.com/square/creator-center/home"
                target="_blank"
                rel="noreferrer"
              >
                获取广场 API <ArrowSquareOut size={15} />
              </a>
            </div>
            <div className="collection-toolbar">
              <h2>
                已添加账号 <span>{accounts.length}</span>
              </h2>
              <label className="search-input">
                <MagnifyingGlass size={19} />
                <input
                  placeholder="搜索账号名称"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            {!accounts.length ? (
              <div className="empty-state">
                <UsersThree size={56} weight="thin" />
                <h3>连接你的第一个广场账号</h3>
                <p>
                  添加 API Key 后，即可选择账号并发布内容。
                </p>
                <button className="primary" onClick={() => openAccount()}>
                  <Plus size={18} />
                  添加账号
                </button>
              </div>
            ) : (
              <div className="account-table">
                <div className="table-header">
                  <span>账号</span>
                  <span>API 状态</span>
                  <span>密钥</span>
                  <span>操作</span>
                </div>
                {accounts
                  .filter((a) => a.name.includes(search))
                  .map((a) => (
                    <div className="account-row" key={a.id}>
                      <div>
                        <Avatar account={a} />
                        <span>
                          <strong>{a.name}</strong>
                          <small>仅用于本工作台展示</small>
                        </span>
                      </div>
                      <span className="configured">
                        <span className="status-dot" />
                        {connectionTests[a.id]?.loading ? "测试中…" : connectionTests[a.id]?.title || "已配置 · 未测试"}
                      </span>
                      <code>{a.maskedKey}</code>
                      <div className="account-actions">
                        <button
                          type="button"
                          className="secondary connection-test-button"
                          aria-label={"测试连接 " + a.name}
                          disabled={connectionTests[a.id]?.loading}
                          onClick={() => testConnection(a)}
                        >
                          {connectionTests[a.id]?.loading && <CircleNotch className="spin" size={15} />}
                          {connectionTests[a.id]?.loading ? "测试中" : "测试连接"}
                        </button>
                        <IB
                          disabled={connectionTests[a.id]?.loading}
                          label={"编辑 " + a.name}
                          onClick={() => openAccount(a)}
                        >
                          <PencilSimple size={19} />
                        </IB>
                        <IB
                          disabled={connectionTests[a.id]?.loading}
                          label={"删除 " + a.name}
                          onClick={() =>
                            setModal({ kind: "delete-account", account: a })
                          }
                        >
                          <Trash size={19} />
                        </IB>
                      </div>
                    </div>
                  ))}
              </div>
            )}
            <div className="account-note">
              <Info size={18} />
              <span>
                测试连接从服务器发起，不会发布内容或上传文件。接口可达不代表发帖权限有效；请使用广场 OpenAPI Key，不能使用交易 API Key。
              </span>
            </div>
            {accounts.length > 0 && (
              <button
                className="secondary"
                onClick={() => {
                  update({
                    demo: false,
                    selectedAccounts: accounts.slice(0, 1).map((a) => a.id),
                  });
                  nav("compose");
                }}
              >
                开始创作
                <ArrowSquareOut size={17} />
              </button>
            )}
          </section>
        )}
        {(page === "drafts" || page === "history") && (
          <section className="collection-page">
            {page === "history" && (
              <div className="info-strip compact">
                <ClockCounterClockwise size={21} />
                <p>这里记录通过本工作台发起的发布，包含每个账号的独立结果。</p>
              </div>
            )}
            <div className="collection-toolbar">
              <div className="filter-tabs">
                {(page === "drafts"
                  ? [
                      ["all", "全部"],
                      ["post", "帖子"],
                      ["article", "文章"],
                      ["video", "视频"],
                    ]
                  : [
                      ["all", "全部记录"],
                      ["post", "帖子"],
                      ["article", "文章"],
                      ["video", "视频"],
                    ]
                ).map(([id, t]) => (
                  <button
                    className={filter === id ? "active" : ""}
                    key={id}
                    onClick={() => setFilter(id)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <label className="search-input">
                <MagnifyingGlass size={18} />
                <input
                  placeholder={
                    page === "drafts" ? "搜索草稿内容" : "搜索发布内容"
                  }
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            {(page === "drafts" ? ds : hs).length === 0 ? (
              <div className="empty-state">
                {page === "drafts" ? (
                  <FileText size={56} weight="thin" />
                ) : (
                  <ClockCounterClockwise size={56} weight="thin" />
                )}
                <h3>
                  {search
                    ? "没有找到匹配内容"
                    : page === "drafts"
                      ? "灵感，值得被好好保存"
                      : "每一次发布，都从这里开始"}
                </h3>
                <p>
                  {page === "drafts"
                    ? "编辑内容会自动保存，也可以随时手动存草稿。"
                    : "发布后即可查看时间、账号、状态和帖子链接。"}
                </p>
                <button className="primary" onClick={() => nav("compose")}>
                  前往创作中心
                </button>
              </div>
            ) : page === "drafts" ? (
              <div className="draft-list">
                {ds.map((d) => (
                  <article className="draft-row" key={d.id}>
                    <div className="draft-type">
                      {d.type === "video" ? (
                        <VideoCamera size={27} />
                      ) : (
                        <FileText size={27} />
                      )}
                    </div>
                    <button className="draft-content" onClick={() => resume(d)}>
                      <div>
                        <span className="badge">{types[d.type]}</span>
                        <h3>{d.title || "未命名草稿"}</h3>
                      </div>
                      <p>{d.body || "暂无正文"}</p>
                      <small>
                        {dateText(d.updatedAt)} · {d.body?.length || 0} 字 ·{" "}
                        {d.selectedAccounts?.length || 0} 个账号
                      </small>
                    </button>
                    <div className="row-actions">
                      <button
                        className="secondary small"
                        onClick={() => resume(d)}
                      >
                        继续编辑
                        <CaretRight size={15} />
                      </button>
                      <IB
                        label={"导出 " + (d.title || "草稿")}
                        onClick={() => exportDraft(d)}
                      >
                        <DownloadSimple size={19} />
                      </IB>
                      <IB
                        label={"删除 " + (d.title || "草稿")}
                        onClick={() =>
                          setModal({ kind: "delete-draft", draft: d })
                        }
                      >
                        <Trash size={19} />
                      </IB>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="history-list">
                {hs.map((h) => (
                  <article className="history-row" key={h.id}>
                    <div className="history-main">
                      <div>
                        <span className="badge subtle">
                          {types[h.type] || "内容"}
                        </span>
                        <time>{dateText(h.createdAt)}</time>
                      </div>
                      <h3>{h.title || h.body?.slice(0, 45) || "未命名内容"}</h3>
                      <p>{h.body?.slice(0, 150)}</p>
                    </div>
                    <div className="history-results">
                      {h.results?.map((r, i) => (
                        <div className="history-result" key={r.accountId + i}>
                          <span>
                            {r.accountName ||
                              accounts.find((a) => a.id === r.accountId)
                                ?.name ||
                              r.accountId}
                          </span>
                          <span className={"result-status " + r.status}>
                            {r.status === "success" ? (
                              <CheckCircle size={16} />
                            ) : (
                              <WarningCircle size={16} />
                            )}{" "}
                            {statusText(r.status)}
                          </span>
                          {r.postUrl &&
                            /^https:\/\/(www\.)?binance\.com\//.test(
                              r.postUrl,
                            ) && (
                              <a
                                href={r.postUrl}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="查看帖子"
                              >
                                <ArrowSquareOut size={17} />
                              </a>
                            )}
                          {r.error && <small>{r.error}</small>}
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept={
          draft.type === "video"
            ? "video/mp4,video/webm,video/quicktime"
            : "image/png,image/jpeg,image/gif,image/webp"
        }
        multiple={draft.type === "post"}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          uploadFiles(files);
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <CheckCircle size={20} />
          {toast}
        </div>
      )}
      {modal?.kind === "connection-test" && (
        <Modal title="测试账号连接" onClose={() => setModal(null)}>
          <div className="connection-result" aria-live="polite" aria-busy={!!connectionTests[modal.account.id]?.loading}>
            <p className="modal-intro">{modal.account.name} · 使用已保存的广场密钥</p>
            {connectionTests[modal.account.id]?.loading ? (
              <div className="connection-loading"><CircleNotch className="spin" size={25} /><span>正在从服务器连接币安…</span></div>
            ) : (
              <>
                <div className={"connection-outcome " + connectionTests[modal.account.id]?.status}>
                  {connectionTests[modal.account.id]?.status === "reachable" ? <CheckCircle size={26} /> : <WarningCircle size={26} />}
                  <h3>{connectionTests[modal.account.id]?.title}</h3>
                </div>
                <p className="connection-message">{connectionTests[modal.account.id]?.message}</p>
                <dl className="connection-details">
                  <dt>密钥状态</dt><dd>{({ invalid: "密钥不存在或无效", expired: "密钥已过期" })[connectionTests[modal.account.id]?.keyStatus] || "发帖权限尚未验证"}</dd>
                  <dt>诊断代码</dt><dd>{connectionTests[modal.account.id]?.code}{connectionTests[modal.account.id]?.httpStatus ? ` · HTTP ${connectionTests[modal.account.id].httpStatus}` : ""}</dd>
                  <dt>测试时间</dt><dd>{connectionTests[modal.account.id]?.checkedAt ? dateText(connectionTests[modal.account.id].checkedAt) : "—"}{Number.isFinite(connectionTests[modal.account.id]?.elapsedMs) ? ` · ${connectionTests[modal.account.id].elapsedMs} ms` : ""}</dd>
                </dl>
              </>
            )}
            <div className="inline-info"><Info size={18} />只查询接口响应，不会发布内容或上传文件。测试反映服务器的网络状况。</div>
            <footer>
              <button className="secondary" onClick={() => setModal(null)}>关闭结果</button>
              <button className="primary" disabled={connectionTests[modal.account.id]?.loading} onClick={() => testConnection(modal.account)}>重新测试</button>
            </footer>
          </div>
        </Modal>
      )}
      {modal?.kind === "account" && (
        <Modal
          title={modal.account ? "编辑账号" : "添加发布账号"}
          onClose={() => {
            if (!busy) {
              setModal(null);
              setForm({ name: "", apiKey: "" });
            }
          }}
        >
          <form className="modal-form" onSubmit={saveAccount}>
            <label>
              展示名称
              <input
                autoFocus
                required
                maxLength={40}
                placeholder="例如：我的行情观察号"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
              />
              <small>仅修改本站展示，不会更改币安广场昵称。</small>
            </label>
            <label>
              币安广场 OpenAPI Key
              <input
                type="password"
                autoComplete="new-password"
                required={!modal.account}
                placeholder={
                  modal.account ? "留空保留原密钥" : "粘贴该账号的广场 API Key"
                }
                value={form.apiKey}
                onChange={(e) =>
                  setForm((f) => ({ ...f, apiKey: e.target.value }))
                }
              />
              <small>密钥仅传送到本站服务端，并加密保存。</small>
            </label>
            <div className="inline-info">
              <Info size={18} />
              保存后可在账号列表点击“测试连接”，检查服务器到币安的连接；实际发帖权限以发布结果为准。
            </div>
            {formError && (
              <p className="error-text" role="alert">
                {formError}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setModal(null);
                  setForm({ name: "", apiKey: "" });
                }}
              >
                取消
              </button>
              <button className="primary" disabled={busy} type="submit">
                {busy ? <CircleNotch className="spin" /> : <ShieldCheck />}
                {busy ? "保存中" : "保存账号"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {modal?.kind === "chart" && (
        <Modal title="添加 K 线图表" onClose={() => setModal(null)}>
          <div className="modal-form">
            <p className="modal-intro">
              把行情图表放进你的帖子，发布时转为图片。
            </p>
            <label>
              交易对
              <select
                value={chartForm.symbol}
                onChange={(e) =>
                  setChartForm((f) => ({ ...f, symbol: e.target.value }))
                }
              >
                {[
                  "BTCUSDT",
                  "ETHUSDT",
                  "BNBUSDT",
                  "SOLUSDT",
                  "XRPUSDT",
                  "DOGEUSDT",
                ].map((s) => (
                  <option key={s} value={s}>
                    {s.replace("USDT", " / USDT")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              时间周期
              <select
                value={chartForm.interval}
                onChange={(e) =>
                  setChartForm((f) => ({ ...f, interval: e.target.value }))
                }
              >
                {[
                  ["15m", "15 分钟"],
                  ["1h", "1 小时"],
                  ["4h", "4 小时"],
                  ["1d", "1 天"],
                ].map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-info">
              <Info size={18} />
              读取公开行情，获取失败时会提示重试。
              图片不包含币安原生交易跳转挂件。
            </div>
            <footer>
              <button className="secondary" onClick={() => setModal(null)}>
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  if (uploading) return notify("媒体正在上传，请稍后添加图表");
                  if (draft.media.length >= 4 && !draft.chart)
                    return notify("最多 4 张图片，请先移除一张");
                  if (
                    !draft.chart ||
                    draft.chart.symbol !== chartForm.symbol ||
                    draft.chart.interval !== chartForm.interval
                  )
                    chartImage.current = null;
                  update({ chart: chartForm });
                  setModal(null);
                }}
              >
                插入图表
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {(modal?.kind === "link" || modal?.kind === "coin") && (
        <Modal
          title={modal.kind === "link" ? "插入链接" : "插入币种"}
          onClose={() => setModal(null)}
        >
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get("value").trim();
              if (modal.kind === "link" && !/^https?:\/\//i.test(v))
                return notify("请输入以 https:// 或 http:// 开头的链接");
              insert(
                modal.kind === "coin"
                  ? "$" + v.replace(/^\$/, "").toUpperCase() + " "
                  : v + " ",
              );
              setModal(null);
            }}
          >
            <label>
              {modal.kind === "link" ? "链接地址" : "币种简称"}
              <input
                autoFocus
                name="value"
                required
                placeholder={modal.kind === "link" ? "https://…" : "BTC"}
              />
            </label>
            <footer>
              <button className="primary">插入正文</button>
            </footer>
          </form>
        </Modal>
      )}
      {modal?.kind === "switch" && (
        <Modal title="切换内容类型" onClose={() => setModal(null)}>
          <p className="modal-intro">
            切换为{types[modal.type]}
            会移除当前媒体和图表，文字与标签会保留。当前草稿会先保存一份。
          </p>
          <div className="modal-footer">
            <button className="secondary" onClick={() => setModal(null)}>
              继续编辑
            </button>
            <button
              className="primary"
              onClick={async () => {
                clearTimeout(timer.current);
                if (!(await persist(draft)))
                  return notify("保存失败，请先导出草稿");
                if (active.current.updatedAt !== draft.updatedAt)
                  return notify("内容刚刚更新，请再次点击以保存最新版本");
                selection.current = null;
                setDraft({
                  ...draft,
                  id: uid(),
                  type: modal.type,
                  media: [],
                  chart: null,
                  updatedAt: new Date().toISOString(),
                });
                setModal(null);
              }}
            >
              保存并切换
            </button>
          </div>
        </Modal>
      )}
      {(modal?.kind === "delete-account" || modal?.kind === "delete-draft") && (
        <Modal
          title={modal.kind === "delete-account" ? "删除账号" : "删除草稿"}
          onClose={() => setModal(null)}
        >
          <p className="modal-intro">
            {modal.kind === "delete-account"
              ? "将移除“" +
                modal.account.name +
                "”及保存的密钥，币安账号不受影响。"
              : "删除后无法恢复，可先导出备份。"}
          </p>
          <div className="modal-footer">
            <button className="secondary" onClick={() => setModal(null)}>
              取消
            </button>
            <button className="danger-button" onClick={deleteItem}>
              确认删除
            </button>
          </div>
        </Modal>
      )}
      {modal?.kind === "capabilities" && (
        <Modal title="发布能力说明" wide onClose={() => setModal(null)}>
          <div className="capability-table">
            {[
              [
                "帖子 / 文章 / 视频",
                "支持官方发布接口。帖子最多 4 张图；文章 1 张封面；视频不可与图片混发。",
              ],
              [
                "表情 / 话题 / 币种 / 链接",
                "随正文发布，话题与币种由币安解析。",
              ],
              [
                "草稿排版",
                "加粗、斜体和列表保存在草稿中；当前公开接口提交纯文本，发布前会提醒。",
              ],
              ["K 线", "支持图表预览与图片发布，不支持原生交易跳转挂件。"],
              [
                "其他原生组件",
                "投票、资产/盈亏、交易记录挂件等暂无已验证的公开发布字段。",
              ],
              ["草稿与历史", "由本工作台保存，发布历史仅包含本站发起的记录。"],
            ].map(([t, b]) => (
              <div key={t}>
                <strong>{t}</strong>
                <span>{b}</span>
              </div>
            ))}
          </div>
          <a
            className="external-doc"
            href="https://github.com/binance/binance-skills-hub/tree/main/skills/binance/square-post"
            target="_blank"
            rel="noreferrer"
          >
            查看官方接口说明
            <ArrowSquareOut size={16} />
          </a>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title="确认发布到币安广场"
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <div className="confirm-content">
            <p>
              以下账号将分别收到一条内容，请核对后发布。
            </p>
            <div className="confirm-accounts">
              {confirmation.accounts.map((a) => (
                <div key={a.id}>
                  <Avatar account={a} size={32} />
                  {a.name}
                  <Check size={16} />
                </div>
              ))}
            </div>
            <div className="confirm-summary">
              <strong>{confirmation.draft.title || "未命名内容"}</strong>
              <p>{confirmation.draft.body.slice(0, 180)}</p>
              <small>
                {types[confirmation.draft.type]} ·{" "}
                {textBody(confirmation.draft).length} 字 ·{" "}
                {confirmation.draft.media.length +
                  (confirmation.draft.chart ? 1 : 0)}{" "}
                个附件
              </small>
            </div>
            {confirmation.draft.html &&
              /<(b|strong|i|em|ul|ol|blockquote)\b/i.test(
                confirmation.draft.html,
              ) && (
                <div className="inline-warning">
                  <WarningCircle size={19} />
                  当前 API
                  按纯文本发布，加粗、斜体和列表样式不会保留。草稿排版不受影响。
                </div>
              )}
            {confirmation.draft.chart && (
              <div className="inline-info">
                <Info size={18} />K 线以静态图片发布。
              </div>
            )}
            {confirmation.error && (
              <p className="error-text" role="alert">
                {confirmation.error}。重试会查询同一次提交，请勿新建重复发布。
              </p>
            )}
            <footer>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                返回编辑
              </button>
              <button className="primary" disabled={busy} onClick={publish}>
                {busy ? <CircleNotch className="spin" /> : <PaperPlaneTilt />}
                {busy
                  ? "正在处理…"
                  : confirmation.error
                    ? "重试本次提交"
                    : "确认发布"}
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {result && (
        <Modal
          title="发布结果"
          onClose={() => setResult(null)}
        >
          <div className="publish-result">
            {result.results?.map((r) => (
              <div key={r.accountId}>
                <Avatar
                  account={result.accounts?.find((a) => a.id === r.accountId)}
                  size={36}
                />
                <strong>
                  {result.accounts?.find((a) => a.id === r.accountId)?.name ||
                    r.accountId}
                </strong>
                <span className={"result-status " + r.status}>
                  {statusText(r.status)}
                </span>
                {r.error && <p>{r.error}</p>}
              </div>
            ))}
          </div>
          <p className="modal-intro">
            结果已保存到发布历史。
          </p>
          <div className="modal-footer">
            <button className="secondary" onClick={() => setResult(null)}>
              继续编辑
            </button>
            <button
              className="primary"
              onClick={() => {
                setResult(null);
                nav("history");
              }}
            >
              查看发布历史
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
