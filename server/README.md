# API 与服务器运行模式

服务使用 Node.js 原生模块。Linux 服务器通过 `bash start.sh` 启动 `server/production.mjs`，默认监听 `0.0.0.0:8081`，同端口提供构建后的网页与 API，并要求管理员 HTTP Basic 认证。配置和一键管理见 [部署说明](../docs/deployment.md)。

开发模式入口 `server/index.mjs` 仍仅绑定 `127.0.0.1:8787`，由 Vite 同源代理 `/api`。API_PORT 仅控制开发 API 端口；生产使用 PORT。

## 数据与安全

- 账号、草稿、本站发布记录、媒体索引保存在 `.data/database.json`，媒体文件保存在 `.data/media/`。
- API Key 经 AES-256-GCM 加密保存；主密钥位于 `.data/master.key`，尽力设置文件权限为 0600。Windows 使用当前目录继承的文件 ACL。主密钥和数据库处于同一电脑，**这不防范有权读取本机全部文件的用户或恶意程序**。备份需一并保存整个 `.data`，不要提交至代码仓库。
- 响应仅包含掩码 Key 与“已配置”状态，不声称 Key 已验证或账号在线。只有用户手动测试连接或确认发布时，才在服务端解密 Key 并发送到官方币安接口。测试结果仅保留在当前页面，避免旧网络状态或旧密钥结果被误用。
- 服务面向单管理员使用，不提供多租户隔离。生产入口对页面、接口与媒体统一认证；开发 API 只供本机访问。生产 HTTP 不提供传输加密，长期公网运行可配 HTTPS 反向代理。Sites 静态前端发布不会自动部署这套密钥存储。
- 请求有 Host/Origin 限制，不开放 CORS；JSON、媒体大小、声明 MIME 和文件签名都会检查。图片最多 10 MB，视频最多 100 MB；只支持 PNG/JPEG/GIF/WebP 与 MP4/MOV/WebM/AVI，不接受 SVG/HTML。

## 接口

生产模式除 `/healthz` 外均先验证访问凭据；写请求同时验证 Origin。`/api/health` 返回 localOnly 表示当前模式，不包含密钥。

所有 JSON 错误格式为 `{ "error": "可读错误", "code": "CODE" }`。

| 方法与路径 | 请求/返回 |
| --- | --- |
| GET `/api/health` | 本地状态、文件限制、能力 |
| GET `/api/accounts` | `{accounts: [...]}` |
| POST `/api/accounts` | `{name, apiKey, color?, avatar?}` → `{account}` |
| PATCH `/api/accounts/:id` | `{name?, apiKey?, color?, avatar?}` → `{account}`，空 Key 保留原值 |
| POST `/api/accounts/:id/test` | `{}` → `{test:{status,title,message,code,keyStatus,checkedAt,elapsedMs,httpStatus?}}`，仅查询连接状态 |
| DELETE `/api/accounts/:id` | `{deleted: true}`，只删除本站配置 |
| GET `/api/drafts` | `{drafts: [...]}`，按最近更新排序 |
| PUT `/api/drafts/:id` | 带 updatedAt 的草稿对象 → `{draft}`；拒绝旧编辑版本 |
| DELETE `/api/drafts/:id` | `{deleted: true}` |
| POST `/api/media` | `{name,type,data,duration?,width?,height?}`；data 为 base64/data URL → `{media:{id,url,type,name,size,...}}` |
| GET `/api/media/:id` | 文件内容；支持单段字节 Range |
| GET `/api/history` | `{history: [...]}`，仅本站发起的记录，最新在前 |
| POST `/api/publish` | 下述发布对象 → 历史记录对象 |

账号：`{id,name,color,avatar,keyConfigured,maskedKey,createdAt,updatedAt}`。avatar 为 8 字符以内的文字或表情。展示名称只存在本站。

草稿：`{id,type,title,body,html,tags?,chart?,media?,mediaIds?,selectedAccounts?,coverMediaId?,duration?,demo?,createdAt,updatedAt,clientUpdatedAt,savedAt}`。媒体应先上传再保存引用；不将文件 base64 存进草稿。

草稿 PUT 必须提供 ISO 编辑时间 updatedAt；后端保留此时间并另外记录 savedAt。旧于当前版本的保存返回 409 DRAFT_STALE；相同时间戳对应不同内容返回 409 DRAFT_VERSION_CONFLICT。相同时间戳与相同内容的重试直接返回现有草稿。DELETE 会持久化删除标记，飞行中的旧 PUT 返回 409 DRAFT_DELETED，不能重新创建已删除的 id；用户新建草稿须使用新 UUID。

发布对象：

```json
{
  "requestId": "唯一UUID，在本次发布重试时保持不变",
  "accountIds": ["账号id"],
  "type": "post",
  "title": "",
  "body": "用户确认的最终正文 #标签 $BTC",
  "mediaIds": [],
  "coverMediaId": null,
  "duration": null,
  "demo": false
}
```

界面仅提交 `demo:false`，已移除演示入口。服务启动时自动迁移原始样例和模拟历史，并保留已编辑的草稿与真实数据；清理前保存一次数据库副本。为兼容已有客户端与隔离测试，接口仍要求 `demo` 显式为布尔值。`true` 永不请求币安，可使用 `demo-main` 等示例 id，所有历史和账号结果均有 `demo:true`，不生成真实帖链接。媒体仍须是本地已上传、已验证的文件。

真实发布逐账号执行，每个结果为 `success`、`failed` 或 `uncertain`；处理中可为 `pending`。只有币安确认成功才标记 success。504/上游服务错误或提交时连接中断按 uncertain 处理，用户应先去广场检查，不能自动重发。

同一个 requestId + 同样内容只发送一次，再次请求返回已有记录（`replayed:true`）；进行中返回 HTTP 202。相同 id 对应不同内容返回 409。请求超时时前端应保留 requestId，并通过历史记录查结果。进程重启将未完成结果标记 uncertain，永不自动重新提交。若只重试失败账号，应再次让用户确认并生成新的 requestId，不能把成功或未知账号混入自动重试。

## 账号连接测试

测试只调用官方 `POST /bapi/composite/v2/public/pgc/openApi/image/imageStatus`，使用随机新票据查询状态；不调用上传预签名、上传或发布接口，不写发布历史。此接口在 [官方 lib.mjs](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/lib.mjs) 中用于只读媒体状态轮询；用不存在的票据探测连接是本工作台的实现方式，并非官方独立密钥验证功能。

已完成的诊断返回 HTTP 200 与 `test`：`status` 为 `reachable` 或 `error`；`keyStatus` 为 `unverified`、`invalid` 或 `expired`。官方明确的 `220003` / `220004` 分别表示密钥不存在/过期；其他接口响应即便为 `000000` 也不宣称发帖权限有效。测试限时 12 秒，不跟随重定向，响应大小受限，不返回原始上游正文、密钥或异常信息。每账号不允许同时测试，所有账号最多同时 8 个测试；接口依旧受生产身份认证及来源校验保护。

诊断区分 DNS、超时、TLS、网络不可达、连接拒绝/中断、HTTP 限流/访问限制和异常响应。发布前的媒体请求失败也展示具体网络原因；正式提交中断仍标记结果不确定，不会自动重发。

## 支持范围与限制

适配器根据 [Binance 官方 square-post 源码](https://github.com/binance/binance-skills-hub/tree/main/skills/binance/square-post/scripts)（2026-09-18 核对）实现：

- 短帖正文、表情、`#话题`、`$币种`；最多 4 张图片。
- 文章标题、纯文本正文、可选 1 张封面。文章封面使用 coverMediaId 或一个 mediaIds 引用。
- 单视频；需正数 duration 秒和图片 coverMediaId。封面由前端浏览器截帧或用户选择，不依赖 ffmpeg。
- 图片/视频经官方预签名上传、处理状态轮询后再发布。预签名仅接受 HTTPS，不带 API Key，禁止重定向和显式本机/IP 上传地址。
- K 线作为导出的图片发布。原生可交互 K 线、投票、交易组件、官方富文本文章 HTML 均没有在已核实 API 中实现，**不应标示为原生功能支持**。html 只用于本站草稿；实际发送 bodyTextOnly。
- 历史只记录本站发起的发布；不拉取其他客户端历史、账号资料、阅读数据，也不能编辑或删除已发布到币安的内容。
- 官方 Skill 文档给出的每日额度为每账号 100 次发帖、400 次上传；本站不声称剩余额度准确，最终以平台响应为准。

官方参考：[媒体及发布协议 lib.mjs](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/lib.mjs)、[文章/图片参数](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/post-image.mjs)、[视频参数](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/post-video.mjs)。

## 验证

`node --test tests/api.test.mjs` 使用临时文件夹、本机 HTTP 请求及注入的模拟上游，覆盖加密、接口脱敏、持久化、各媒体发布结构、部分失败、并发幂等、504/连接中断、重启恢复、演示隔离和安全错误。测试不会使用真实 Key、不会向币安发布。没有真实 Key 时，不能宣称已完成线上发布验收。

