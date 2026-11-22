# ProkBot Plus Mac 补丁

[English](README.en.md)

为 Grok Bot 0.71.2 macOS 客户端连接自己的 Host，支持 Apple 芯片（Apple Silicon）和 Intel 芯片，Intel 是实验支持。需要 Node.js 22.12+。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md#client-packages)，实现原理见[技术文档](../docs/ARCHITECTURE.md#mac-client)。`clients/desktop/` 是客户端主进程，Windows 和 Android 客户端也用到这里的代码。

## 使用

```sh
node patchers/desktop/patch.mjs
```

工具按本机芯片自动下载并校验 0.71.2 原版（Apple 芯片用 ARM64 版，Intel 用 x64 版），生成 `output.noindex/Grok Bot.app`。移入「应用程序」，填写 Host 地址和 6 位配对码。连接页的 Tailcat 开关只在粘贴 Host 管理页「远程访问」里的连接链接时打开，填局域网或 HTTPS 地址时保持关闭。给另一种芯片的 Mac 生成时，加 `--arch arm64` 或 `--arch x64`。

**Intel Mac（实验）**：官方给 Intel 单独提供了 0.71.2 安装包。它和 Apple 芯片版是两次构建，JavaScript 相同，文件名和本机模块不同。`patchers/desktop/x64/` 里的 recipe 由 Apple 芯片版对齐移植而来（`windows/tools/port-desktop-recipes.mjs --platform mac`），加进去的代码完全相同；Tailcat 另外编译了 x86_64 版（`dist/network/x64/`）。已有用户在 Intel Mac（macOS 15.7.7）上实测：自动识别芯片、生成、启动、配对和多轮对话都正常（[#6](https://github.com/ferretgeek/prokbot-plus/issues/6)）。本机图形界面控制（`--identity auto`）和 Tailcat 还没有人在 Intel Mac 上测过，遇到问题请开 issue。

官方 Mac 版已经更新到 1.2.3（2026-11-19 核对），这里仍然固定为 0.71.2：Mac 版是单独的程序包，要另做补丁，并在 Mac 上测试安装、签名和本机图形界面控制，维护者目前没有 Mac。0.71.2 仍可从官方地址下载，补丁会核对它的完整摘要。

已有原版 `.app` 或 `.dmg` 时，可增加 `--source "/path/to/Grok Bot.app"`。DMG 按文件大小识别是哪种芯片的版本；`.app` 不是本机芯片的版本时，再加 `--arch`。

`--verify-only` 在临时目录回放固定版本的补丁，不生成客户端。手动指定的 DMG 也检查完整 SHA-256；Mac 上还会验证输入 App 的原签名。本项目没有在 macOS 上实测安装、启动、配对或聊天。可接受的原包和官方最新版本见[首页版本表](../README.md#client-versions)。

需要控制本机图形界面时，在命令中增加 `--identity auto`，使用已有签名证书。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
