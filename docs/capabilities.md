# 币安广场能力对应

核实日期：2026-09-18。依据 Binance 官方 square-post 2.0.0 技能及公开脚本，不代表账户已实测通过。

| 用户需求                      | 本工作台实现                           | 公开接口边界                           |
| ----------------------------- | -------------------------------------- | -------------------------------------- |
| 多账号发布                    | 本地账号选取、逐账号发送、逐账号结果   | 每个账号使用自己的广场 OpenAPI Key     |
| 帖子                          | 正文、表情、话题、币种、链接、最多4图  | 正文为 bodyTextOnly                    |
| 文章                          | 标题、正文、单封面                     | 富文本排版只保存在草稿，不承诺接口支持 |
| 视频                          | 单视频上传、封面提取与时长             | 不与图片混发；浏览器须能解码该视频     |
| K线                           | 公开行情预览，导出图表PNG发布          | 不是可跳转交易页的原生K线挂件          |
| 展示名称                      | 可添加与编辑                           | 仅本站名称，不修改广场个人资料         |
| 草稿                          | 浏览器逐份备份 + 本机服务自动持久化    | 不同步币安原生草稿                     |
| 历史                          | 本工作台发起的逐账号结果和可用帖子链接 | 不拉取其他客户端历史                   |
| 投票、资产/盈亏、交易记录组件 | 界面说明当前不支持                     | 未发现已验证的公开发布字段             |

## 官方来源

- [官方技能](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/SKILL.md)
- [发布与上传协议](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/lib.mjs)
- [短帖和文章](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/post-text.mjs)
- [图文和封面](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/post-image.mjs)
- [视频](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/square-post/scripts/post-video.mjs)
- [原生编辑器功能](https://www.binance.com/en/support/faq/detail/a6dd93f996cb42a897651acfa19a98d6)

旧版介绍可能仍写“仅纯文本”，与现官方技能不一致。实现依照新版官方源码，实际能力仍需接入用户账号后核实。
