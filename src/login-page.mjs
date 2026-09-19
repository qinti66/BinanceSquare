function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function renderLoginPage({ error = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>登录 · 墨金创作台</title>
  <style>
    :root { font-family: Inter, "Noto Sans SC", "Microsoft YaHei", sans-serif; color: #eff0f3; background: #101216; color-scheme: dark; font-synthesis: none; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; padding: 32px 20px; }
    main { width: 100%; max-width: 420px; }
    .brand { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 28px; }
    .brand-mark { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid #4b401a; border-radius: 10px; background: #28230f; color: #f0b90b; font-size: 23px; font-weight: 800; }
    .brand-name { font-size: 20px; font-weight: 800; letter-spacing: 1px; }
    .brand-subtitle { margin-top: 4px; color: #969da9; font-size: 10px; letter-spacing: 2px; }
    .card { border: 1px solid #2b3038; border-radius: 16px; padding: 32px; background: #14171c; box-shadow: 0 16px 56px #00000026; }
    h1 { margin: 0 0 10px; font-size: 25px; line-height: 1.4; font-weight: 700; }
    .intro { margin: 0 0 26px; color: #969da9; font-size: 14px; line-height: 1.8; }
    .field { margin-bottom: 20px; }
    label { display: block; margin-bottom: 9px; font-size: 14px; font-weight: 500; }
    input, button { font: inherit; }
    input { display: block; width: 100%; min-width: 0; height: 46px; padding: 0 13px; border: 1px solid #343a44; border-radius: 7px; background: #101216; color: #eff0f3; font-size: 16px; }
    input::placeholder { color: #7e8796; opacity: 1; }
    input:hover { border-color: #555e6d; }
    input:focus { border-color: #f0b90b; }
    input:focus-visible, button:focus-visible { outline: 2px solid #f0b90b; outline-offset: 4px; }
    button { width: 100%; min-height: 46px; margin-top: 4px; border: 0; border-radius: 7px; padding: 11px 16px; background: #f0b90b; color: #181600; font-size: 15px; font-weight: 700; cursor: pointer; }
    button:hover { background: #f8cd39; }
    button:active { background: #dda907; }
    .error { margin: 0 0 22px; padding: 11px 13px; border: 1px solid #68343d; border-radius: 7px; background: #301e24; color: #ffb2b9; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
    .help { margin: 22px 0 0; color: #969da9; font-size: 12px; line-height: 1.8; }
    footer { margin-top: 22px; color: #969da9; text-align: center; font-size: 12px; line-height: 1.8; }
    @media (max-width: 440px) { body { padding: 24px 16px; } .card { padding: 26px 22px; } .brand { margin-bottom: 24px; } }
  </style>
</head>
<body>
  <main>
    <div class="brand" aria-label="墨金创作台 Square Studio">
      <div class="brand-mark" aria-hidden="true">墨</div>
      <div><div class="brand-name">墨金创作台</div><div class="brand-subtitle">SQUARE STUDIO</div></div>
    </div>
    <section class="card" aria-labelledby="login-heading">
      <h1 id="login-heading">登录创作台</h1>
      <p class="intro">登录后继续管理账号、草稿与发布记录。</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
      <form action="/login" method="post">
        <div class="field">
          <label for="username">用户名</label>
          <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="80" placeholder="请输入用户名" required autofocus>
        </div>
        <div class="field">
          <label for="password">密码</label>
          <input id="password" name="password" type="password" autocomplete="current-password" maxlength="512" placeholder="请输入密码" required>
        </div>
        <button type="submit">登录</button>
      </form>
      <p class="help">请使用本站的管理员账号与密码登录。币安广场 API Key 请在登录后的账号管理中添加。</p>
    </section>
    <footer>各浏览器可独立登录，已同步内容会自动共享。</footer>
  </main>
</body>
</html>`;
}
