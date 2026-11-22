# ProkBot Plus Mac Patch

[简体中文](README.md)

Connect Grok Bot 0.71.2 for macOS to your Host, on Apple Silicon and, experimentally, on Intel Macs. Requires Node.js 22.12+.

The complete deployment steps are in the [deployment guide](../docs/AI-INSTALL.en.md#client-packages), and how it works is in the [technical documentation](../docs/ARCHITECTURE.en.md#mac-client). `clients/desktop/` is the client's main process; the Windows and Android clients use its code too.

## Use

```sh
node patchers/desktop/patch.mjs
```

Automatically downloads and verifies the 0.71.2 original for this Mac's chip (the ARM64 build on Apple Silicon, the x64 build on Intel), then generates `output.noindex/Grok Bot.app`. Move it into Applications and enter your Host address and 6-character pairing code. Turn on the Tailcat switch on the connect screen only when pasting the connection link from Remote access in the Host console; leave it off for a LAN or HTTPS address. To build for a Mac with the other chip, add `--arch arm64` or `--arch x64`.

**Intel Macs (experimental)**: the official 0.71.2 release has a separate Intel installer. It is a second build with the same JavaScript but different file names and native modules. The recipes in `patchers/desktop/x64/` are aligned ports of the Apple Silicon recipes (`windows/tools/port-desktop-recipes.mjs --platform mac`) and add exactly the same code, and Tailcat has an x86_64 build (`dist/network/x64/`). A user has confirmed it on an Intel Mac (macOS 15.7.7): chip detection, building, launch, pairing and multi-turn chat all work ([#6](https://github.com/ferretgeek/prokbot-plus/issues/6)). Local graphical control (`--identity auto`) and Tailcat have not been tried on an Intel Mac yet; please open an issue if you hit problems.

The official Mac app has moved to 1.2.3 (checked November 19, 2026), but this patch stays on 0.71.2: the Mac app is a separate package that needs its own patch and testing of installation, signing and local graphical control on a Mac, which the maintainers don't have. 0.71.2 can still be downloaded from the official address, and the patcher checks its full digest.

To use an existing `.app` or `.dmg`, add `--source "/path/to/Grok Bot.app"`. A DMG is recognized by its size; for an `.app` built for the other chip, also add `--arch`.

`--verify-only` replays the fixed recipes in temporary storage without building a client. A supplied DMG must match the full archive SHA-256, and the Mac tool verifies the input app's signature. This project has not tested installation, launch, pairing or chat on macOS. See the [version table](../README.en.md#client-versions) for accepted inputs and the latest official releases.

For local graphical control, add `--identity auto` to sign with an existing certificate.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most of this project's code was written with AI assistance.
