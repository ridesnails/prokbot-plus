# ProkBot Plus maintainer handoff

[中文](HANDOFF.md) · [Deployment and recovery](AI-INSTALL.en.md) · [Architecture and interfaces](ARCHITECTURE.en.md) · [Version matrix](../README.en.md#client-versions)

## Starting point

Handoff dated November 18, 2026. Upstream ProkBot is based on `3e9fe8c`. The table lists the downloadable releases; check later changes with `git log v1.4.0..main` and `git status --short`.

| Baseline | Contents |
| --- | --- |
| Plus Release `v1.4.0` | Per-Bot primary/backup model routes and context compaction ([PR #2](https://github.com/ferretgeek/prokbot-plus/pull/2) by @jun9100): `host/runtime/model-routing.mjs` parses services, profiles, the default route and Bot routes; `model-session.mjs` moves to backup profiles in order before any output and keeps the rest of the turn on the backup; `host-summarize.mjs` provides manual compaction (`POST /admin/api/agents/:id/summarize`). Legacy configuration keeps its format until the first save from the new model page. `routingMigrated` means it is still in the legacy format, and `legacyAdaptiveRouting` means it used task-difficulty routing (Jev); only then does the page mention Jev and ask for confirmation. The clients are the same as `v1.3.0`. |
| Plus Release `v1.3.1` | Host deployment tool fix ([#4](https://github.com/ferretgeek/prokbot-plus/issues/4)): `host/release/backup.py` reads optional keys in the raw `docker inspect` JSON with `index`, so `backup` and `update` work again on Docker 29 with Compose 2.40. Lockfiles flagged by dependency alerts were also updated; the clients are unchanged from `v1.3.0`. |
| Plus Release `v1.3.0` | Newest first, with a fallback: Windows defaults to 1.1.0, and `--version 0.71.2` or a 0.71.2 installer builds the fallback (`windows/patchers/desktop/inputs.mjs` recognizes the release by size and SHA-256). The Android interface comes from Windows 1.1.0 by default; `fallback` in `android/patchers/supported.json` keeps 0.71.2, and `renderer-patches.mjs` is split per release. The Android bridge adds 1.1.0 dictation, startup defaults, computer view ticket refresh, `insertCSS`, a `moveBefore` fallback and dialog layouts. The Host is the same as `v1.2.1`. |
| Plus Release `v1.2.1` | Older Android WebView support: `android/client/compat.js` adds newer built-ins that the official interface calls directly and explains a page that did not start ([#3](https://github.com/ferretgeek/prokbot-plus/issues/3)). Otherwise the same as `v1.2.0`. |
| Plus Release `v1.2.0` | Five platform tool ZIPs and `SHA256SUMS.txt`. The Windows patcher accepts official 1.1.0: `windows/tools/desktop-recipes/` generates the recipes, and `mac/clients/desktop/` adds the 1.1.0 interfaces (per-edge registration, dictation, search mapping). The 0.71.2 inputs moved to `windows/patchers/desktop/0.71.2/` for Android. Host: backups, image identification and recovery in `host/deploy.py` and `host/release/`; three model protocols, streams and tool ordering in `host/runtime/`; management UI and CLI in `host/server/` and `host/tools/host-admin.mjs`; capacity measurement in `host/bench/`. |
| Plus Release `v1.1.0` (`43c6d59`) | A client-tools release, not a Host upgrade; the Windows patcher still required 0.71.2. |

Windows x64 requires **1.1.0**; Mac ARM64 requires **0.71.2**; iOS requires **1.16.0 (23152)**. The unofficial Android shell is **1.1.0 (10100)** and takes its UI from Windows 1.1.0 by default. Both Windows and Android can fall back to **0.71.2**. Host input is `d0a4baa`; the execution desktop is `9d2ac1b` (`linux/amd64`). The official desktop release checked on November 14, 2026 is **1.1.0**; Mac 1.1.0 is not supported yet.

## Where to edit

| Work | Code and dependencies |
| --- | --- |
| Host, models, management UI | `host/deploy.py` is the operator CLI; `host/deploy/` runs inside the container. `host/runtime/model-session.mjs` dispatches model requests; `host/server/models.mjs` stores configuration. Runtime changes need an image rebuild. `host/server/application-guide.md` and `host/runtime/teach-skill/SKILL.md` are read by the running Host. |
| Desktop and Android | Windows and Mac share `mac/clients/desktop/`. Windows and Android use `windows/patchers/desktop/original.mjs`; Android shares the Windows client's inputs: the recommended release in `windows/patchers/desktop/` and the fallback in `windows/patchers/desktop/0.71.2/`. The Android web bridge is in `android/client/`; Kotlin is in `android/shell/`. Web-bridge changes alone need no shell rebuild. After changing Kotlin, run `node android/shell/release-shell.mjs` and verify `android/dist/` against its manifest. |
| Vendor input updates | Desktop: `*/patchers/desktop/supported.json` and sibling `recipes/manifest.json`; Android: `android/patchers/supported.json`; iOS: `ios/recipes/ios/manifest.json`; Host: `host/recipes/host/manifest.json`. Stage candidate recipes separately from production pins; verify each source and output digest. `windows/tools/desktop-recipes/build.mjs` generates the Windows recipes from `spec.mjs`; `--check` verifies that the committed files are reproduced byte for byte. |

## Verification

From the full source checkout, use Node.js 22.12+ and Python 3.10+. These commands do not require starting an existing server. Run one suite at a time.

```sh
node ci/check-inputs.mjs
node ci/homepage-versions.mjs
python -B host/deploy.py --help
node --test --test-concurrency=1 "host/tests/*.test.mjs"
node --test --test-concurrency=1 "windows/tests/*.test.mjs"
node --test --test-concurrency=1 "mac/tests/*.test.mjs"
node --test --test-concurrency=1 "android/tests/*.test.mjs"
```

The handoff machine keeps pinned originals under Git-ignored `inputs/`. In Windows PowerShell set the optional Android input (the recommended 1.1.0 installer) before running the suites; otherwise the stock-file cases are skipped. The pinned Host recipe check reads `PROKBOT_TEST_HOST_ARCHIVE`; without it, only `inputs/host/sand-host-bundle-d0a4baa.tgz` is tried. Windows and Android use the same recommended original, and the fallback is verified once more with the 0.71.2 original. On other machines supply your own originals with matching digests; the tests do not read implicit paths outside the checkout.

```powershell
$windows = (Resolve-Path 'inputs/windows/Grok_Bot_1.1.0_Setup.exe').Path
$fallback = (Resolve-Path 'inputs/windows/Grok_Bot_0.71.2_Setup.exe').Path
$env:PROKBOT_ANDROID_TEST_SOURCE = $windows
node windows/tools/desktop-recipes/build.mjs --source $windows --check
foreach ($source in $windows, $fallback) {
  node windows/patchers/desktop/patch.mjs --source $source --verify-only
  node android/patchers/patch.mjs --source $source --verify-only
}
```

Rechecked before releasing `v1.3.0` on November 16: Host 132 passed, one Linux-only symlink test skipped; Windows 28/28, shared desktop 59/59, Android 58/58 (with the 1.1.0 original), CI tools 45/45 plus 21 Python tests. Windows and Android `--verify-only` passed with both the 1.1.0 and 0.71.2 originals. `v1.3.1` additionally covers Docker 29 with Compose 2.40 through read-only pre-backup checks and a mock Engine API; no backup or update was run on the real instance. For what was tested live on the Windows 0.71.2 fallback and on the Android 1.1.0 and 0.71.2 interfaces, see [desktop compatibility](ARCHITECTURE.en.md#desktop-compatibility). Older WebView support was checked on an Android 11 emulator (WebView 83) and on an Android 15 emulator (WebView 124) with the newer built-ins removed, not on a HarmonyOS 卓易通 device. The Host deployment tests need Windows' own `tar.exe`; under Git Bash, `/usr/bin/tar` on PATH makes two of them fail, so put `C:\Windows\System32` first. A generated 1.1.0 portable build was accepted against a self-hosted Host on Windows 11; see [desktop compatibility](ARCHITECTURE.en.md#desktop-compatibility) for the scope. Still not accepted: real speech recognition, real-time voice against a real Host, reconnect against a real Host (only a local mock Host was used), and running the installer over a real 0.71.2 install (only a copied 0.71.2 profile was tested). No Mac, iPhone or iPad hardware acceptance was performed this round.

Rechecked before releasing `v1.4.0` on November 18: Host 176 passed, one Linux-only test skipped; Windows 28/28, shared desktop 59/59, Android 58/58 (with the 1.1.0 original), CI tools 45/45 plus 21 Python tests. Windows and Android `--verify-only` passed with both the 1.1.0 and 0.71.2 originals, and the admin-page browser test passed 11/11, including the migration notice for both kinds of legacy configuration. A test instance with its own project name, port, volumes and image tags on Docker 29.1.3 with Compose 2.40.3 was also checked against a real Anthropic Messages model. A single model was configured on the `v1.3.1` image and used for a plain conversation and a tool conversation. After switching to the PR #2 image, the earlier conversations were readable and the legacy configuration kept chatting. Saving without confirming migration returned 409. With an unreachable primary (`127.0.0.1:9`) and a real backup, a turn with two tool calls recorded one switch. A Bot on the default route worked. Compacting an idle Bot took 8 seconds and the Bot still remembered its earlier commands, while a running Bot returned 409. After rebuilding the image from the release commit on the same instance, the migration flags were correct, a two-step tool turn still recorded one switch and the default route worked. `Ignoring exec stream shutdown during detached drain` in the Host log is INFO and also common on the production instance. The production Host has not been upgraded to `v1.4.0` yet.

## Operations and release

- **Deploy:** use `doctor → init → up → status` for a fresh instance. Keep the existing `--home`, `--project` and topology for `update`. `--host-only` selects the Host half of a split deployment; chat also requires a configured model and an enabled amd64 execution node. See [split deployment](AI-INSTALL.en.md#split-host).
- **Recover:** volume backups exclude `.env`, Docker images and the host OS. `host/release/backup.py restore` in `v1.1.0` and earlier restores volumes only; `host/deploy.py recover --directory` is available from `v1.2.0` and records immutable image IDs. Stop the old identity, restore to a new project, and verify with the original device; do not attach an old image to potentially migrated volumes. See [volume backup and recovery](AI-INSTALL.en.md#volume-recovery).
- **Measure:** `host/bench/bench.py selftest` is offline; `validate` checks one round and `compare` checks comparable baseline and candidate cohorts. Split deployments require both machines' metrics. The homepage minimum (2 cores / 4 GB) and recommendation (4 cores / 8 GB) come from the 2C4G and 4C8G functional runs and the production instance's actual usage, and cover personal use only. The two time-bounded 2C2G runs missed their targets. Three one-hour sustained runs with several clients have not been done. See [capacity evidence](ARCHITECTURE.en.md#capacity-evidence).
- **Ship:** from a clean, pushed commit, run `python -B ci/release-packages.py --help` and build the five tools ZIPs and checksums from that commit. Test separately extracted archives; run Windows and Android `--verify-only` with both the pinned 1.1.0 and 0.71.2 installers. The release procedure in root `AGENTS.md` covers tag, homepage and asset checks. Android in-place updates reuse the original signing key. Vendor programs and complete signed clients are not release assets.
- **Local materials:** fixed inputs and a test signing identity are under `inputs/`. Test receipts, benchmark measurements and replay scripts from November 14–15 are in `.cache/acceptance/receipts-20261115.zip`, with per-entry `SHA256SUMS.txt`. Access files, signing material and this archive are not part of the source distribution or releases.
