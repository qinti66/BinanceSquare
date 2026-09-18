# 墨金创作台 · Square Studio

币安广场多账号发布工作台：账号管理、帖子/文章/视频编辑、表情与标签、K 线图片、自动草稿、逐账号发布结果及历史记录。

## Linux 服务器一键运行

将完整项目上传或拉取到服务器，在项目目录执行：

```bash
bash start.sh
```

首次启动自动准备 Node.js LTS、安装锁定版本的依赖、构建前端、生成访问密码并后台运行。无需 Docker、PM2 或全局安装 npm 包。再次启动会检查已有进程与构建缓存。服务器须能访问 nodejs.org 和 npm 仓库；需要 Bash、curl、tar/xz、sha256sum、flock 等常见 Linux 工具。

启动成功后，终端显示访问地址和首次生成的登录信息。浏览器打开 **http://服务器IP:8081**，输入账号与密码即可。网页、API 和媒体使用同一个端口。关闭 SSH 不会停止服务。

```bash
bash stop.sh       # 停止，等待正在处理的请求结束
bash restart.sh    # 重启，配置或代码更新后使用
bash status.sh     # 查看运行状态
```

服务器安全组/防火墙需允许访问所设 TCP 端口。脚本不会替你修改云安全组或系统防火墙。

详细配置、更新、备份和排错见 [Linux 部署说明](docs/deployment.md)。

## 配置与数据

- `.env`：根目录统一配置文件，可在启动前编辑监听地址、端口、访问账号与密码、数据目录和公开访问来源；不提交到版本库。
- 从 Git 拉取后，首次启动自动创建 `.env`；也可先运行 `cp .env.example .env` 再编辑。`ADMIN_PASSWORD` 留空时，`bash start.sh` 会生成随机密码写回 `.env`，仅首次生成时显示。
- 兼容旧部署：没有 `.env` 时优先迁移 `.env.production` 并保留旧文件，否则使用 `.env.example`；两者同时存在时以 `.env` 为准。
- `.data/`：账号、草稿、发布记录、上传媒体及加密主密钥；停止、重启、构建均保留数据。
- `.run/`、`.runtime/`、`logs/`：运行状态、可选的项目内 Node 运行时、日志。
- 服务器参数只从 `.env` 读取，未填写项使用程序默认值；SSH/系统中的同名环境变量不会覆盖配置。
- 默认监听 `0.0.0.0:8081`。修改 `.env` 的 `PORT` 后运行 `bash restart.sh`。
- 账号 API Key 在服务端 AES-256-GCM 加密保存，不回传明文；管理员仍需保护服务器上的配置和数据文件。

HTTP 访问支持 IP + 端口；HTTP 本身不加密登录密码与传输内容。公网长期使用可在同一服务前配置 HTTPS 反向代理，设置 `PUBLIC_ORIGIN` 为完整 HTTPS 站点来源。

## 本地开发

使用符合依赖要求的 Node.js，执行 `npm ci`、`npm run dev`，打开 http://localhost:4173 。开发 API 仅监听本机 8787 端口。服务器部署请使用上面的 `start.sh`。

## 功能与能力边界

- 多账号添加、编辑显示名称、选择目标账号；账号列表可手动测试服务器到币安的连接，显示 DNS、超时、TLS、HTTP 访问限制及明确的密钥错误。测试不发布内容、不上传文件，接口可达不代表发帖权限有效。
- 帖子、文章、视频，图片及封面上传、视频自动截取封面；表情、话题、币种、链接。
- 编辑即时在浏览器备份，并自动同步到服务端；草稿搜索、继续编辑、删除与导出。
- 发布逐账号记录成功、失败或结果不确定；同一请求的重试不会重复发送。
- 首次打开为空白工作台，不预置演示账号、内容或发布记录；发布前需选择自己的账号并确认。
- 公开接口支持纯文本正文；草稿富文本格式不会作为富文本提交，确认时会提示。
- K 线以静态图片发布。原生 K 线挂件、投票、资产/盈亏等没有已核实的公开发布字段。
- 历史只包含本工作台发起的记录，不同步其他客户端记录。
- 未提供真实 API Key，线上发布尚未实测。

## 旧版演示数据清理

更新代码并运行 `bash restart.sh`，然后刷新浏览器。服务会自动清除原始样例草稿和模拟发布记录；已有真实账号、媒体、草稿及真实发布记录保留。在旧演示模式中自行编辑过的草稿也会保留，并取消演示账号选择。旧模拟提交不会转为真实发布。

清理前自动留存一次恢复副本：服务端为数据目录下的 `database.before-demo-cleanup-v1.json`，浏览器为本站 localStorage 中的 `square.before-demo-cleanup.v1`。不需要手动清空浏览器或删除数据目录。

## 验证

```bash
npm test
npm run build
npm run test:browser
npm run test:browser:media
npm run test:browser:production
npm run test:browser:connection
```

浏览器验收使用隔离数据与模拟上游，不修改用户 `.data`。需安装兼容 Chromium 的浏览器，通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定路径。

[接口及官方来源](server/README.md) · [设计验收](design-qa.md) · [服务器部署说明](docs/deployment.md)
