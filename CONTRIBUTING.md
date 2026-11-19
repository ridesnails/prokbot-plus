# 参与贡献 / Contributing

## 中文

- **问题与建议：** 先查[故障排查](docs/AI-INSTALL.md#附录-b故障排查)，再到 [Issues][issues] 报告问题或建议功能。报错时附上服务端系统和 Docker 版本、客户端平台和版本、模型接口格式、复现步骤、预期与实际结果，以及几行相关 Host 日志。
- **隐私与安全：** 贴日志或截图前删去 API Key、管理员密码、配对码和服务器公网地址。漏洞按 [SECURITY.md](SECURITY.md) 私下报告。
- **提交改动：** PR 写明改动及验证结果。入口：[代码结构](docs/ARCHITECTURE.md)、[测试与发布][agents]、[发布包校验器][archives]。双语文档同步修改；补丁基于用户下载的原版，PR 不附官方程序、解包代码、IPA、生成的 APK 或网页版界面包（`android/dist/` 仅含项目自有外壳）。
- **许可：** 提交贡献即同意按 [ProkBot 非商业许可证 1.0](LICENSE) 发布。

**CI：** 平台 ZIP 不含 `ci/`。仓库的[回归模板][ci]覆盖 Linux、Windows（含安装器）和 macOS（含 iOS 网络层）；默认不运行，有工作流写权限的维护者可复制到 `.github/workflows/tests.yml` 启用。[安装器模板][installer-ci]同样默认不运行，复制到 `.github/workflows/installer-native.yml` 后，仅在 GitHub 托管的一次性 Windows x64 运行器上用两个合成版本验证安装器，无需官方客户端。

## English

- **Issues and ideas:** Check [troubleshooting](docs/AI-INSTALL.en.md#appendix-b-troubleshooting), then use [Issues][issues] for bugs or feature requests. For bugs, include the server OS and Docker version, client platform and version, model API format, reproduction steps, expected and actual results, and a few relevant Host log lines.
- **Privacy and security:** Remove API keys, admin passwords, pairing codes and public server addresses from logs or screenshots. Report vulnerabilities privately via [SECURITY.md](SECURITY.md).
- **Pull requests:** Describe the change and what you verified. See the [code layout](docs/ARCHITECTURE.en.md), [testing and release guide][agents], and [release archive checker][archives]. Update both versions of bilingual docs. Patches use originals downloaded by the user; PRs exclude official binaries, extracted code, IPAs, generated APKs and web client bundles (`android/dist/` contains only the project's own shell).
- **License:** By contributing, you agree to release your work under the [ProkBot Noncommercial License 1.0](LICENSE).

**CI:** Platform ZIPs omit `ci/`. The [regression template][ci] covers Linux, Windows (including the installer) and macOS (including the iOS network layer). It is inactive until a maintainer with workflow write access copies it to `.github/workflows/tests.yml`. The [installer template][installer-ci] is inactive as well; copied to `.github/workflows/installer-native.yml`, it checks the installer with two synthetic versions only on a disposable GitHub-hosted Windows x64 runner and needs no official client.

[issues]: https://github.com/ferretgeek/prokbot-plus/issues
[agents]: https://github.com/ferretgeek/prokbot-plus/blob/main/AGENTS.md
[archives]: https://github.com/ferretgeek/prokbot-plus/blob/main/ci/verify-release.py
[ci]: https://github.com/ferretgeek/prokbot-plus/blob/main/ci/regression-tests.yml
[installer-ci]: https://github.com/ferretgeek/prokbot-plus/blob/main/ci/installer-native.yml
