# Linux 服务器部署

## 首次启动

将完整项目复制到服务器，保留隐藏文件 `.openai/hosting.json`（构建需要），然后进入项目目录：

```bash
bash start.sh
```

脚本会准备兼容的 Node.js LTS 环境、安装依赖、构建静态网页、生成 `.env`，再把服务启动到后台。没有适用 Node 时，在项目 `.runtime/` 内下载官方 Linux 二进制并校验 SHA-256，不覆盖系统 Node。

默认访问 `http://服务器IP:8081`。未配置密码时，首次启动会生成随机密码并在终端显示登录信息。账号管理、API、页面、媒体均要求相同的访问凭据；仅 `/healthz` 返回最小运行状态。本站访问密码与币安广场 OpenAPI Key 是两种不同凭据。

基本要求：现代 glibc Linux、x86_64 或 ARM64、Bash、curl、tar 与 xz、sha256sum、flock，以及足够的内存和磁盘完成 npm 构建。Node 官方二进制不适用于旧版 CentOS 7 或 Alpine/musl。首次需要联网访问 nodejs.org 与 npm 仓库。已有兼容运行时和构建后，启动服务不需再次下载。

## 日常操作

```bash
bash start.sh
bash stop.sh
bash restart.sh
bash status.sh
```

可从其他目录调用这些脚本，脚本会自动定位项目。无需先执行 chmod；统一使用 `bash`。

- 重复 start 不会启动第二个实例。
- stop 只针对本项目记录并核实身份的进程；停止、重启均不删除数据。
- 停止期间会等待正在处理的请求，发布和大文件请求可能使停止耗时较长。
- SSH 断开后继续运行。默认脚本不注册开机自启；服务器重启后执行 `bash start.sh`。

## 统一配置文件

所有服务器配置放在项目根目录的 `.env`，可以在首次启动前自行编辑。从 Git 拉取后如无此文件，可先创建：

```bash
cp .env.example .env
```

配置示例：

```dotenv
HOST=0.0.0.0
PORT=8081
ADMIN_USER=admin
ADMIN_PASSWORD=
DATA_DIR=.data
PUBLIC_ORIGIN=
```

`HOST` 和 `PORT` 设置监听地址与端口；`ADMIN_USER` 和 `ADMIN_PASSWORD` 设置网页登录凭据；`DATA_DIR` 设置数据目录；`PUBLIC_ORIGIN` 可指定完整访问来源，例如 `https://square.example.com`，直接使用 IP + 端口时可以留空。

`ADMIN_PASSWORD` 留空时，`bash start.sh` 会生成随机密码并写回 `.env`，仅在首次生成时显示；也可自行设置至少 16 个字符的独立密码。`.env` 已排除在 Git 之外，请保管好此文件。服务运行后修改配置，执行 `bash restart.sh` 生效。密码更改后，浏览器原凭据失效时会重新要求登录；可关闭浏览器窗口或使用无痕窗口重新登录。

仅使用 `127.0.0.1` 作为 HOST 会限制为本机访问；需要 IP 访问时保持默认 `0.0.0.0`。云安全组与 Linux 防火墙须放行配置的 TCP 端口，脚本不修改防火墙。

启动时若 `.env` 不存在，脚本优先从旧 `.env.production` 迁移并保留旧文件；没有旧文件时从 `.env.example` 创建。两者同时存在时以 `.env` 为准。服务器参数只从 `.env` 读取，未填写的项使用程序默认值，不使用系统同名环境变量；空 `PUBLIC_ORIGIN` 表示关闭域名限制。

`npm start` 是读取 `.env` 的前台生产入口，需要先运行 `bash start.sh` 初始化密码并构建 `dist/client`；日常使用一键脚本即可。

## 更新代码

```bash
git pull
bash restart.sh
```

没有 Git 仓库时，上传新代码覆盖源文件，再重启。部署包中的 `.env` 是供新安装使用的模板；升级时不要用它覆盖现有配置。旧版若只有 `.env.production`，保留旧文件并让启动脚本迁移。更新时保留 `.env`、`.data/`，不要上传其他电脑的 `node_modules/`、`.run/` 或 `.runtime/`。脚本检测源文件或依赖变化后重新构建。启动失败时查看终端提示与 `logs/`。

这是单管理员、单进程应用。不要让不同进程、不同项目副本或开发服务同时读写同一个 DATA_DIR。

## 数据备份与迁移

先停止服务，然后备份 `.env` 和整个 `.data/`（自定义 DATA_DIR 时备份实际目录）。其中 `master.key` 必须与 `database.json` 一同备份，否则无法解密已保存的币安密钥。媒体也在数据目录内。

迁移到另一台服务器：停止旧服务，复制代码、配置与完整数据目录到新服务器，再执行 `bash start.sh`。浏览器离线备份按访问来源保存；已同步的服务端草稿会随数据目录迁移。切换 IP/端口前确认所需草稿已同步。

## HTTP 与 HTTPS

IP + 端口的 HTTP 访问已做兼容处理，不依赖仅 HTTPS 可用的 `crypto.randomUUID()`。HTTP 不加密网络传输；公网长期运行可由 Nginx/Caddy 等终止 HTTPS，将请求代理到本服务，并设置 `PUBLIC_ORIGIN=https://你的域名`，末尾不要加 `/`。

反向代理应保留 `Host`（含非标准端口）与 `Authorization`，允许至少 140 MB 请求体（100 MB 视频经 Base64 后体积增加），并给发布请求足够的读取超时时间。应用不盲目信任客户端 `X-Forwarded-*` 头。若只允许代理连接，可将 HOST 改为 `127.0.0.1`。

## 故障定位

- 无法访问：先 `bash status.sh`，再核对启动端口、监听地址、云安全组和防火墙。
- 端口占用：停止使用同端口的服务或修改 PORT；脚本不会杀死其他程序。
- 下载/安装失败：检查服务器网络、DNS 与证书；修复后再次 start。
- Node 二进制无法运行：检查 Linux 架构与 glibc 版本，使用受支持的现代系统。
- 密码忘记：有服务器文件权限的管理员可修改 `.env` 并重启。
- 发布结果不确定：先到币安广场核实。同一请求的恢复不会自动重新向币安提交。

运行机制：生产模式只提供构建后的 `dist/client` 静态文件及同端口 API，不提供源代码或 `.data` 目录；开发模式仍独立使用 Vite 与本机 API。

## 无法通过 IP 访问时

以下以端口 8081 为例，先确认使用 `bash start.sh` 或 `bash restart.sh`，而非仅监听本机的 `npm run dev`。配置修改后只执行 start 不会重启已运行的进程。

```dotenv
HOST=0.0.0.0
PORT=8081
PUBLIC_ORIGIN=
```

浏览器使用 `http://服务器公网IP:8081`。`0.0.0.0` 是监听地址，`127.0.0.1` 是服务器本机检查地址，都不是另一台电脑应输入的服务器公网 IP。没有配置 HTTPS 代理时不要使用 https://。

在服务器项目目录执行（不输出密码）：

```bash
bash status.sh
ss -lntp 'sport = :8081'
curl --noproxy '*' -i --connect-timeout 3 --max-time 5 http://127.0.0.1:8081/healthz
```

- 本机连接失败：先检查服务是否启动、实际监听端口和 logs/service.log。
- 监听 127.0.0.1：外部无法直连，改 HOST 后 restart。
- 本机 200、监听 0.0.0.0、外部超时：检查公网 IP、NAT 映射及云安全组/防火墙。
- 首页 401：已连通，需要输入 .env 的网站访问账号和密码。
- 首页 403 且 healthz 200：检查 PUBLIC_ORIGIN；直接 IP 访问时留空。healthz 不受域名限制，200 不能单独证明首页可访问。
