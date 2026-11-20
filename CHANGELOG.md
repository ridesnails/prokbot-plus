# 更新记录 / Changelog

版本号从 ProkBot Plus 1.0.0 开始，上游 ProkBot 的版本附在最后。每个版本的完整说明见对应的 [Release](https://github.com/ferretgeek/prokbot-plus/releases) 和提交记录。

Versions start at ProkBot Plus 1.0.0; upstream ProkBot releases are listed at the end. Full notes for each version are in its [release](https://github.com/ferretgeek/prokbot-plus/releases) and the commit history.

## ProkBot Plus 1.6.0 (2026-11-20)

Mac 补丁增加 Intel 芯片（实验），首页和文档整理。只有 Mac 补丁有程序变化，Host、Windows、Android、网页版和 iOS 与 1.5.1 相同。Experimental Intel Mac support, plus homepage and documentation work. Only the Mac patch changes; Host, Windows, Android, web and iOS are the same as 1.5.1.

- **Intel Mac（实验）/ Intel Macs (experimental)**：Mac 补丁按本机芯片选用官方 0.71.2 的 Apple 芯片版或 Intel 版，`--arch` 可以指定，给 DMG 时按大小识别。Intel 版的 recipe 由 Apple 芯片版对齐移植，加进去的代码完全相同；另外编译了 x86_64 的 Tailcat。只在 Windows 上验证了 recipe 能用在 Intel 原版上，没有在 Intel Mac 上测试（[#6](https://github.com/ferretgeek/prokbot-plus/issues/6)）。The Mac patcher picks the official 0.71.2 Apple Silicon or Intel build for the Mac's chip (`--arch` overrides; a DMG is recognized by size). The Intel recipes are aligned ports that add exactly the same code, with an x86_64 Tailcat. The recipes were checked against the Intel original on Windows only, not on an Intel Mac.
- **首页 / Homepage**：中英文 README 重写得更短，去掉重复的段落和不准确的说法。开头换成 Windows、网页版、Android 三端同框的大图，下面 6 张图展示联网和画图、执行命令前确认、手机、平板浏览器、自选模型和配对码连接（都是演示数据，手机和平板截图是 1.1.0 界面）。Both READMEs are shorter, without repeated sections or inaccurate claims. They now open with one image of the Windows, web and Android clients side by side, followed by six images of web search and pictures, command approval, phones, tablet browsers, your own models and pairing (demo data; the phone and tablet shots show the 1.1.0 interface).
- **官方网站分享的 Bot / Bots shared on the official website**：写明 x.ai/bot/… 页面的「Add to Grok Bot」在本项目里不能用：模板存在官方云端，要官方账号才能下载，客户端也不接管官方的 `grokbot://` 链接（[#7](https://github.com/ferretgeek/prokbot-plus/issues/7)）。Documented that "Add to Grok Bot" on x.ai/bot/… pages does not work here: the templates live in the official cloud and need an official account, and the clients leave the official `grokbot://` links alone.
- **配对码 / Pairing codes**：英文文档把配对码写成「6 位数字」，实际是 6 个字母和数字，已改正。The English documents called the pairing code six digits; it is six letters and digits.
- **文档 / Docs**：维护交接文档并入技术文档的「测试与维护」，技术文档、Host 说明、部署手册和各平台说明精简；更新记录压缩成每个版本的要点。The maintenance handoff is merged into the technical documentation's tests and maintenance section; the technical documentation, Host README, deployment guide and platform READMEs are condensed, and this changelog keeps the key points of each release.
- **清理 / Cleanup**：删除没有引用的旧文件：`android/tests/browser-flows.py`（只适用 0.71.2 界面，已由 `web/tests/browser-flows.py` 取代）、`host/examples/plugins/echo.json`（`host/server/application-guide.md` 有同样的示例）、`windows/tools/desktop-renderer-migration.md`，以及不再使用的截图；Windows 首次连接的截图移到 Windows 说明里。Removed unreferenced old files: `android/tests/browser-flows.py` (0.71.2 only, superseded by `web/tests/browser-flows.py`), `host/examples/plugins/echo.json` (the same example is in `host/server/application-guide.md`), `windows/tools/desktop-renderer-migration.md` and unused screenshots; the Windows first-connection screenshot moved to the Windows README.

## ProkBot Plus 1.5.1 (2026-11-19)

修复上游 ProkBot 作者在合并评审（[Gitee PR #2](https://gitee.com/ahaduoduoduo/ProkBot/pulls/2)）中指出的问题。服务端修复要升级 Host，桌面修复要重新生成 Windows（或 Mac）客户端；Android、网页版和 iOS 与 1.5.0 相同。Fixes for problems the upstream author found while reviewing the merge. Upgrade the Host for the server fixes and rebuild the Windows (or Mac) client for the desktop fixes; Android, web and iOS are unchanged from 1.5.0.

- **OpenAI Chat 兼容接口 / OpenAI Chat-compatible endpoints**：`[DONE]` 和 `finish_reason` 有一个就算结束；`stop` 带工具调用时照常执行；空参数在工具没有必填参数时按 `{}` 处理（Responses 也一样）。Either end marker completes the stream, tool calls after `stop` run, and empty arguments mean `{}` for tools without required parameters (Responses too).
- **桌面客户端遇到 401 / Desktop client and 401**：先用 `/connect/status` 核对，只有设备确实被撤销才断开要求重新配对。The client checks `/connect/status` first and asks for new pairing only when the device was revoked.
- **设置文件损坏 / Damaged profile**：损坏的 `local-client-persistence.json` 改名保留，客户端按空数据继续。A damaged file is kept under another name and the client continues with empty data.
- **其他 / Other**：启动时直接用保存的主题；并发回复重复的工具调用 ID 不再让对话出错；Codex 提示措辞、`recover` 的错误说明；iOS 补丁从清单读取版本。The saved theme applies before first paint; a reused tool call ID no longer fails a chat; Codex prompt wording, the `recover` message, and iOS reads its version from the manifest.
- **记录 / Records**：官方 Windows 和 Mac 已到 1.2.3、iOS 1.26.0（2026-11-19），本项目尚未适配；问题模板加入网页版。Official Windows and Mac are at 1.2.3 and iOS at 1.26.0, not yet supported here; issue templates gain a web client option.
- 只有自动测试，没有在真实服务器或 Mac 上验收。Automated tests only; not checked on a real server or a Mac.

## ProkBot Plus 1.5.0 (2026-11-19)

新增网页版：在电脑、手机、平板的浏览器里使用自己 Host 上的 Bot，不用装客户端。要升级 Host。New web client: use the Bots on your own Host from any computer, phone or tablet browser, with no client to install. Upgrade the Host to use it.

- **网页版 / Web client**：`node web/patchers/patch.mjs` 从官方 Windows 安装包生成界面包，在管理页「网页版」上传或加 `--upload`；浏览器打开 `Host 地址/web/` 用配对码登录。排版随屏幕自适应，可以看 Bot 的电脑并操作、上传下载附件、收浏览器通知。只使用 Host 上的 Bot 电脑，不支持 Tailcat。`node web/patchers/patch.mjs` builds a bundle from the official Windows installer; upload it on the admin page or with `--upload`, then open `<Host>/web/` and sign in with a pairing code. Adaptive layout, the Bot's computer, attachments and browser notifications. Works with the Bot's computer on the Host only; no Tailcat.
- **安全 / Security**：界面包只在用户自己的 Host 上，按清单校验后整体换入，只提供给已登录的浏览器；登录 Cookie 为 HttpOnly、SameSite=Strict，设备接口还要求专用请求头和同源。The bundle stays on the user's Host, is verified and swapped in whole, and is served only to signed-in browsers; the cookie is HttpOnly and SameSite=Strict, and the device API also requires a dedicated header and same origin.
- **共用桥接 / Shared bridge**：修复 Safari 打开带图对话变白；通知或链接冷启动时等 Bot 列表出现再打开（Android 也受益）。Fixed blank chats with images in Safari; a cold start from a notification or link waits for the Bot list (Android benefits too).
- Release 增加第六个工具包 `prokbot-plus-web.zip`。Releases gain a sixth package, `prokbot-plus-web.zip`.
- 8 种模拟设备尺寸的浏览器测试和一台真实服务器上的隔离实例验收；没有在真机浏览器上测试。Browser tests at 8 emulated device sizes and an isolated instance on a real server; not tested in browsers on real devices.

## ProkBot Plus 1.4.0 (2026-11-18)

社区贡献（[PR #2](https://github.com/ferretgeek/prokbot-plus/pull/2)，@jun9100）：每个 Bot 可以单独选模型并配备用模型，可以手动压缩上下文。要升级 Host，客户端不变。Community contribution by @jun9100: per-Bot models with fallbacks and on-demand context compaction. Upgrade the Host; clients are unchanged.

- **按 Bot 路由 / Per-Bot routing**：模型页分为服务、档案、默认路由和 Bot 路由；单个 Bot 可指定主档案、思考强度和最多 8 个备用，不调用 Jev。旧配置在确认迁移前保持不变。The model page separates services, profiles, a default route and Bot routes; a Bot can set a main profile, reasoning effort and up to 8 fallbacks without Jev. Old settings stay untouched until migration is confirmed.
- **主/备切换 / Fallback**：主模型还没输出时，402、408、429、5xx、网络错误和空闲超时会依次换备用；输出后不切换。Before the main model outputs anything, 402, 408, 429, 5xx, network errors and idle timeouts move to the next fallback; never after output.
- **上下文压缩 / Compaction**：空闲的 Bot 可手动压缩；**行为变化**：旧配置若同时设了非零容量和摘要阈值，升级后会按阈值自动压缩。Idle Bots can be compacted on demand. **Behavior change**: old settings with a non-zero capacity and summary threshold start compacting automatically after the upgrade.
- 管理页的名称不再作为 SVG/HTML 写入图标位置。Names are no longer written as SVG/HTML into icon slots.
- 在 Docker 29 + Compose 2.40 的独立实例上用真实模型验收。Checked with a real model on an isolated Docker 29 + Compose 2.40 instance.

## ProkBot Plus 1.3.1 (2026-11-17)

- **备份与升级 / Backup and update**：修复 Docker 29 + Compose 2.40 上 `deploy.py backup` 和 `update` 报 `map has no entry for key "Mounts"`（[#4](https://github.com/ferretgeek/prokbot-plus/issues/4)）。Fixed `deploy.py backup` and `update` failing on Docker 29 + Compose 2.40.
- **依赖 / Dependencies**：升级 GitHub 依赖提醒指出的 `hono`、`@hono/node-server`、`body-parser` 和 Mac 补丁工具的 `@electron/asar`。Updated the dependencies flagged by GitHub.

## ProkBot Plus 1.3.0 (2026-11-16)

优先用最新版：Windows 和 Android 默认官方 1.1.0，用不了再回退 0.71.2；Mac 仍为 0.71.2。Host 不变。Newest first: Windows and Android default to official 1.1.0 and fall back to 0.71.2; Mac stays on 0.71.2. Host unchanged.

- **Windows 回退 / Windows fallback**：`--version 0.71.2` 或 0.71.2 安装包生成回退版，`--source` 按大小和 SHA-256 识别版本。`--version 0.71.2` or a 0.71.2 installer builds the fallback; `--source` is recognized by size and SHA-256.
- **Android 1.1.0 界面 / Android 1.1.0 interface**：APK 默认用 Windows 1.1.0 的界面，补上听写、启动默认值、手机排版和旧 WebView 兼容；电脑画面每次加载前换取新票据。The APK uses the 1.1.0 interface by default, with dictation, startup defaults, phone layouts and older-WebView support; the computer view fetches a fresh ticket on each load.
- **首页 / Homepage**：README 重写，写明服务器最低和推荐配置。READMEs rewritten with the server minimum and recommendation.

## ProkBot Plus 1.2.1 (2026-11-16)

- **旧版 WebView / Older WebView**：修复较旧的 Android System WebView（例如鸿蒙「卓易通」）配对后白屏（[#3](https://github.com/ferretgeek/prokbot-plus/issues/3)）：`compat.js` 补齐缺少的函数，太旧时显示需要更新的组件。Fixed a blank screen after pairing on older WebView builds: `compat.js` adds missing functions and explains what to update when the WebView is too old.

## ProkBot Plus 1.2.0 (2026-11-16)

Windows 补丁跟进官方 1.1.0，并发布五个平台工具包。Host 改动要更新服务端才生效，更新前先备份。The Windows patch follows official 1.1.0, with five platform packages. Host changes take effect after a server update; back up first.

- **Windows 1.1.0**：recipe 由 `windows/tools/desktop-recipes/` 从官方安装包生成，可逐字节重现；桌面主进程适配 1.1.0 的接口、全局搜索和听写；资料库对话框新增「上传文件」。Recipes are generated reproducibly from the official installer; the main process supports 1.1.0's interfaces, global search and dictation; the library dialog gains an upload button.
- **部署与恢复 / Deployment and recovery**：先构建候选再停机；拒绝漏备份的挂载；`recover` 用记录的精确镜像恢复到新项目。Build before stopping; reject mounts that would escape the backup; `recover` restores into a new project with the recorded images.
- **模型与可靠性 / Models and reliability**：三种接口检查结束事件、取消和损坏数据，错误正文限 64 KiB；记忆提取失败不再让 Host 退出；连续重发同一条消息时停止这一轮。All three adapters check completion, cancellation and bad data, with error bodies capped at 64 KiB; a failed memory extraction no longer stops the Host; repeated resends of the same message end the turn.
- **客户端 / Clients**：Windows 安装器按文件归属升级和卸载，支持并行安装旧版；修复重连、分块上传和设置保存；宽屏表格、弹窗按键。The Windows installer tracks owned files and supports side-by-side installs; reconnect, chunked upload and settings fixes; wider tables and dialog keys.
- **工具 / Tools**：发布包校验、整机基准（`host/bench/`）、首页注明由 6.2Astra 和 Opus5.5 一起维护。Release archive verification, the whole-machine benchmark, and the homepage names 6.2Astra and Opus5.5 as maintainers.

## ProkBot Plus 1.1.0 (2026-11-14)

客户端工具发布，不需要升级服务器。Client tools release; no server upgrade needed.

- **Android 客户端 / Android client**：新增本项目自开发的 Android App（外壳 1.1.0 (10100)），运行官方桌面版的界面（取自 Windows 0.71.2 安装包），照官方手机版排版；支持对话、Bot 电脑的画面和操作、附件、不依赖 Google 推送的通知。New Android app with this project's own shell, running the official desktop interface rearranged after the official phone app: chat, the Bot's computer, attachments and notifications without Google push.
- **ARM64**：Host 可以原生构建在 ARM64 Linux 上，桌面放独立 amd64 节点或同机模拟（实验）；统一的部署入口 `host/deploy.py`。The Host builds natively on ARM64, with the desktop on a separate amd64 node or emulated (experimental); one deployment entry point, `host/deploy.py`.
- **安全 / Security**：保存的设备凭据只在原 Host 地址重试；新配对的 Android 设备没有桌面执行权限；模型请求不跟随重定向。Saved credentials retry only the original Host; new Android devices get no desktop execution rights; model requests refuse redirects.
- **文档 / Docs**：技术说明合并为技术文档，新增 `AGENTS.md`。Technical notes merged into the technical documentation; `AGENTS.md` added.

## 1.0.0（2026-11-10）

基于 ProkBot v2026.11.05（提交 `3e9fe8c`）。Based on ProkBot v2026.11.05 (commit `3e9fe8c`).

- **新增 / New**：Windows x64 客户端（便携版和安装包）；Anthropic Messages 和 OpenAI Responses 两种模型接口；命令行管理工具 `host/tools/host-admin.mjs`；AI 部署手册。Windows x64 client; Anthropic Messages and OpenAI Responses; the admin CLI; the AI deployment guide.
- **修复 / Fixed**：Windows 图片一直加载、中文命令输出乱码；新版 Claude 联网失败、并行搜索误判；生图的画面比例和参考图报错；同一回复的多条消息乱序；自动审查静默失败；Docker 29 containerd 镜像存储下构建失败；从 Windows 上传代码后 Tailcat 丢失可执行权限。Windows images stuck loading and garbled output; web tools with current Claude models and parallel searches; image aspect ratios and reference images; out-of-order messages; silent auto-review failures; builds on Docker 29's containerd store; Tailcat losing its executable bit.

---

## 上游 ProkBot 版本 / Upstream ProkBot releases

来自 https://gitee.com/ahaduoduoduo/ProkBot ，仅作记录。From upstream, for reference.

- **v2026.11.05**：Mac 修复 Bot 置顶、分组及折叠状态的保存。Mac saves pinned Bots, groups and collapsed state.
- **v2026.11.02**：iOS 修复锁屏后 Tailcat 持续重连。iOS stops Tailcat reconnecting while locked.
- **v2026.11.01**：首个公开版本，提供 Mac、iOS、Host 三个补丁工具。First public release, with Mac, iOS and Host patch tools.
