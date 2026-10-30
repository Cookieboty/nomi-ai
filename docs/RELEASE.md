# Releasing Nomi · 发布指南

**v2.0.5 起，面向用户的正式版本是 Go 版**（`apps/desktop-go`，Go 内核 + Wails v3），安装包由
[`.github/workflows/desktop-go-package.yml`](../.github/workflows/desktop-go-package.yml) 构建并发布到
[GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases)。Go 版自己读 Release 里的
`latest-go.json`，检查到新版后提示用户下载（不自动替换，见 [迁移文档 §3.4 D-B11-3](design/migrate-2.0.5-go.md)）；
同一个 Release 还附 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`，让已装的 **2.0.4（Electron）照常在应用内升级到
Go 版**（见下文「2.0.4 → Go 版」）。Electron 版仍随同一个 Release 发布（安装包名 `Nomi-Electron-*`，不进自动更新源）；
≤ v2.0.4 的 Electron 版发布流程见下文「Electron（≤ v2.0.4）」。

## Go 版发布（v2.0.5+）

| 事件                                 | 做什么                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| push `main`                          | `desktop-go.yml`（三平台 go vet / go test、golden 比对、构建）+ `desktop-go-package.yml` 打包与安装验证，产物在 artifact `nomi-go-*`                               |
| PR → `main`                          | `desktop-go.yml`（只改 Go / 视图 / 内核时）；带 `ci:full` 标签才打安装包                                                                                           |
| push tag `v*`（≥ v2.0.5）            | 先跑完整 `desktop-go.yml` → 三平台打包 + 安装/启动验证 → `latest-go.json` → draft Release；`ci.yml` 同时上传 Electron 安装包 → 两套齐全后**自动发布**并标为 latest |
| `workflow_dispatch`（在 tag ref 上） | 补跑：`publish=true` 才发布；`bench=true` 额外跑与 2.0.4 的性能对比                                                                                                |

发一版：

1. 同步版本号（`package.json`、`apps/desktop-electron/package.json`，Go 打包读后者），写 `docs/releases/vX.Y.Z.md`。
2. 在 `main` 上等 `desktop-go` 与 `CI` 都绿。
3. 打 tag 并推送：`git tag -a vX.Y.Z -m "Nomi X.Y.Z" && git push origin vX.Y.Z`。
4. 等 `desktop-go-package` 与 `CI` 都跑完：Release 应有
   - Go 版：`Nomi-X.Y.Z-arm64.dmg`、`Nomi-X.Y.Z-arm64-mac.zip`、`Nomi-X.Y.Z.dmg`、`Nomi-X.Y.Z-mac.zip`、`Nomi-Setup-X.Y.Z.exe`、
     `Nomi-X.Y.Z.AppImage`、`nomi_X.Y.Z_amd64.deb`、`latest-go.json`、`SHA256SUMS`、`latest.yml`、`latest-mac.yml`、`latest-linux.yml`；
   - Electron 版（`ci.yml` 的 `build-electron`）：`Nomi-Electron-X.Y.Z-{arm64,x64}.{dmg,zip}`、`Nomi-Electron-Setup-X.Y.Z.exe`、
     `Nomi-Electron-X.Y.Z.AppImage`。

   两条管线上传到同一个草稿，都调用 `scripts/release/publish-when-complete.sh`：上面的文件全部到齐才发布，后完成的一方发布。
   任一平台失败时 Release 停在 draft：修好后在该 tag 上重跑失败的那条（Go 管线手动触发时勾选 `publish`）。

**两个版本同一个 Release**：自动更新源只来自 Go 管线（`latest*.yml` 指向 Go 安装包，`latest-go.json` 给 Go 版自己用），所以 2.0.4
与 Electron 2.0.5 的用户在应用内都会升级到 Go 版。Electron 安装包改名 `Nomi-Electron-*`（与 Go 版同名会互相覆盖），
electron-builder 以 `--publish never` 打包、不上传它生成的 `latest*.yml`。

签名：mac 只做 Developer ID 签名（`MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`），不公证；Windows 用 `WIN_CSC_LINK` /
`WIN_CSC_KEY_PASSWORD` 签 `Nomi.exe` 与安装器。两者都与 2.0.4 用同一组 secret（同一证书）。mac 证书缺失时，分支构建退化为
ad-hoc 并告警，**tag 发版直接失败**（2.0.4 不接受 ad-hoc 签名的更新）；Windows 证书缺失时不签名（2.0.4 若也没签名就不校验发布者）。

### 2.0.4 → Go 版（应用内升级）

2.0.4 用 electron-updater 6.8.9：读最新 Release 的 `latest*.yml` → 下载 → 校验 sha512 → 用户点「重启并安装」。
`packaging/update-manifest.py` 按 electron-builder 的格式生成这三个文件，指向 Go 版安装包：

| 平台    | 2.0.4 下载                   | 安装方式                                                                                                                                      |
| ------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | `Nomi-Setup-X.Y.Z.exe`       | 以 `--updated --force-run` 运行 Go 安装器：沿用 2.0.4 的目录与卸载项，先静默跑 2.0.4 卸载器（保留数据），装完自动启动；签过名时要求同一发布者 |
| macOS   | `Nomi-X.Y.Z[-arm64]-mac.zip` | Squirrel.Mac 替换 `Nomi.app`，要求新包满足 2.0.4 的签名要求（`com.cookieboty.nomi` + 同一 Team ID）                                           |
| Linux   | `Nomi-X.Y.Z.AppImage`        | 替换原 AppImage 文件后启动                                                                                                                    |

不出 blockmap：electron-updater 取不到 blockmap 时整包下载。用户数据由 Go 版首次启动时迁移（`internal/migrate`）。CI 守住这条路径：

- `manifest` 任务用 2.0.4 自带的 electron-updater 解析生成的 yml（`scripts/release/check-update-feed.mjs`），确认每个平台
  （Windows、mac arm64 / x64、Linux）都挑中 Go 版安装包且 sha512 / size 一致；
- `verify (windows)` 先装从 v2.0.4 源码构建的安装器并运行一次，再以 `--updated --force-run` 跑 Go 安装器，检查自动启动、
  旧 Electron 文件已清、只剩一个卸载项、用户数据还在；tag 上缺 2.0.4 安装器即失败；
- `package (mac)` 检查 `Nomi.app` 的签名标识是 `com.cookieboty.nomi`。

## Electron（≤ v2.0.4）

Electron 版（`apps/desktop-electron`）仍在 `ci.yml` 里构建（push main 出未签名 artifact），但只有 ≤ v2.0.4 的 tag
会经它发布 Release；下面是这条旧流程的说明。

Nomi ships installers for **Windows (NSIS)**, **macOS (DMG, x64+arm64)** and **Linux (AppImage)** via
[electron-builder](https://www.electron.build/), published to
[GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases). Installed apps update through
`electron-updater` (same feed).

### Formal installers · 正式安装包以 CI 为准

**Electron 版的 Win NSIS、Mac DMG、Linux AppImage，以 GitHub Actions artifact 或 tag 触发的 GitHub Release 为准。**

| 来源                                                                       | 用途                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CI` → job `build-electron` → artifact `installer-{linux,mac,win}-<sha>`   | push main / 带 `ci:full` 的 PR / `workflow_dispatch` 的可安装包（未签名也可测） |
| tag `v*`（≤ v2.0.4）→ 同 job + `package:publish:*` → job `publish-release` | 先传到草稿 Release，三平台齐了再发布，供 `electron-updater` 使用                |

- Runner：**ubuntu-latest** → AppImage；**windows-latest** → NSIS `Nomi Setup *.exe`；**macos-latest** → DMG（x64+arm64）。
- **不要**在 Linux 开发机 / box 上用 wine 交叉打 Win/Mac 当正式产物（原生依赖会打成错误平台）。

### 手动触发（Actions → CI → Run workflow）

1. `package_only=true`：跳过 quality/e2e，只打安装包（应急）。
2. `platforms`：`linux` / `mac` / `win` 逗号分隔；留空=三平台都打。
3. 跑完后到该 run 的 Artifacts 下载 `installer-win-*` / `installer-mac-*` / `installer-linux-*`。

### Tag 发版（附到 Release）

```bash
git tag -a v1.0.0 -m "Nomi 1.0.0"
git push origin v1.0.0
```

Workflow 文件：[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)。

---

## What users see · 用户侧

| Step         | 中文                                                                 | English                                                                                 |
| ------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Launch       | 启动约 15 秒后静默检查；也可在 **设置 → 通用 → 更新** 点「检查更新」 | Silent check ~15s after launch; or **Settings → General → Updates → Check for updates** |
| Available    | 自动开始下载；设置页显示进度                                         | Download starts automatically; Settings shows progress                                  |
| Ready        | 「更新已下载，重启后安装」→ 点「重启并安装」→ 确认                   | “Update downloaded” → **Restart and install** → confirm                                 |
| Consent      | **不会**在你未确认时退出安装（`autoInstallOnAppQuit=false`）         | Never quits to install without your confirmation                                        |
| Dev / source | 设置页显示「仅在安装版中可用」                                       | Settings shows updates are unavailable for unpackaged builds                            |

Auto-check can be toggled off in Settings. Periodic re-check is every 6 hours while the app runs.

---

## Cut a release · 如何发一版

> Do **not** push a `v*` tag until CI on `main` (or the release branch) is green and you intend
> users to receive that build. Tags upload to a **draft** GitHub Release, and CI publishes it
> automatically once all three platforms are uploaded.

1. **Bump the version** in sync (semver, no leading `v` in the JSON fields):
   - `package.json` (workspace root)
   - `apps/desktop-electron/package.json` ← electron-builder / electron-updater read this
   - Prefer `pnpm changeset` + `pnpm changeset:version` when a changeset exists; otherwise edit both by hand.
   - Root [`CHANGELOG.md`](../CHANGELOG.md) is generated from `.changeset/*.md`: `pnpm changelog`
     refreshes the _Unreleased_ section (CI runs `pnpm changelog:check`); `pnpm changeset:version`
     first turns _Unreleased_ into `## x.y.z — date`, then consumes the changesets.
   - Write the release notes (EN + 中文, same shape as the previous Release body) in `docs/releases/vX.Y.Z.md`; paste it as the GitHub Release body after the tag build finishes.
2. **Commit** on `main` (or a release PR), wait for CI green on all three platforms.
3. **Tag and push** (example for 1.0.0 — only when you are ready):

   ```bash
   git tag -a v1.0.0 -m "Nomi 1.0.0"
   git push origin v1.0.0
   ```

4. **CI** (`.github/workflows/ci.yml` → `build-electron`):
   - Builds win / mac / linux with signing secrets when present
   - Runs `pnpm --filter @nomi-ai/host-electron run package:publish:{win,mac,linux}` (`--publish always`)
   - Uploads installers + `latest*.yml` / `.blockmap` to a **draft** GitHub Release for that tag
     (`releaseType: draft`), so installed apps don't see it while platforms are still uploading
   - Job `publish-release` (after all three `build-electron` jobs succeed) checks that
     `latest.yml`, `latest-mac.yml` and `latest-linux.yml` are attached, then publishes the draft
     and marks it latest. If a platform failed, the Release stays a draft: fix and re-run, or
     publish it by hand once the missing files are attached
   - On macOS, runs `scripts/release/check-mac-update.mjs`: the job fails if `latest-mac.yml` does not list both the x64 and arm64 zip, or a listed file is missing or its size / sha512 differ. It prints a warning when the build is unsigned, because Squirrel.Mac rejects unsigned updates
5. **Verify the Release** page has, at least:
   - Windows: `Nomi Setup x.y.z.exe` + `latest.yml` + `.blockmap`
   - macOS: for **each** of x64 and arm64 both a `.dmg` (first install) **and** a `-mac.zip` (+ `.blockmap`), plus `latest-mac.yml`. The zip is required: electron-updater's MacUpdater only picks `zip` entries from `latest-mac.yml`, so a Release with only DMGs breaks in-app updates on macOS (`ERR_UPDATER_ZIP_FILE_NOT_FOUND`). Check that `latest-mac.yml` lists both zips
   - Linux: `.AppImage` + `latest-linux.yml`
6. Install a previous build, open **Settings → General → Updates → Check for updates**, confirm download + consent install.

### Dry-run without notifying users

- Run package jobs on a PR/push (already does `--publish never`) and download the workflow **artifacts**.
- Or create a **draft** Release manually and attach artifacts from a green `build-electron` run; draft
  releases are **not** picked up by electron-updater until you publish them.

---

## Secrets · 凭证（签名与公证）

Set these as **repository secrets** (Settings → Secrets and variables → Actions). Exact names:

| Secret name                   | Platform | Required?               | Purpose                                                                                        |
| ----------------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `MAC_CSC_LINK`                | macOS    | optional                | Base64 of the **Developer ID Application** `.p12` (or an `https://` URL to it)                 |
| `MAC_CSC_KEY_PASSWORD`        | macOS    | with `MAC_CSC_LINK`     | Password of that `.p12`                                                                        |
| `APPLE_ID`                    | macOS    | optional (notarization) | Apple ID e-mail of the developer account                                                       |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS    | with `APPLE_ID`         | App-specific password from appleid.apple.com                                                   |
| `APPLE_TEAM_ID`               | macOS    | with `APPLE_ID`         | 10-character Team ID                                                                           |
| `WIN_CSC_LINK`                | Windows  | optional                | Base64 of the Authenticode code-signing `.pfx`/`.p12` (or an `https://` URL)                   |
| `WIN_CSC_KEY_PASSWORD`        | Windows  | with `WIN_CSC_LINK`     | Password of that certificate                                                                   |
| `GH_TOKEN`                    | all      | optional                | Classic PAT (`repo` scope), only if org policy blocks the default token from creating Releases |
| `GITHUB_TOKEN`                | all      | automatic               | Provided by Actions; creates/uploads the Release (`contents: write`)                           |

Encode a certificate for a secret: `base64 -i cert.p12 | pbcopy` (macOS) or
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))` (PowerShell).

### How the gate works · 门控规则

Only **tag** builds (`v*`) read these secrets. The step _Resolve signing / notarization env_ runs
[`scripts/release/signing-env.mjs`](../scripts/release/signing-env.mjs), which exports variables for
electron-builder **only when a whole group is present**:

| Group present                                                     | Exported to electron-builder                  | Result                                    |
| ----------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD`                           | `CSC_LINK`, `CSC_KEY_PASSWORD`                | macOS app + DMG signed (hardened runtime) |
| …and `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | the same three names                          | **notarized** (notarytool) and stapled    |
| `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`                           | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`        | NSIS installer + exe signed               |
| anything missing / partial                                        | nothing (`CSC_IDENTITY_AUTO_DISCOVERY=false`) | unsigned build, `::notice::` explains why |

Notarization is enabled automatically when the three Apple secrets are present (electron-builder 26
notarizes whenever `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` are in the environment);
it needs a signed build, so it is skipped when the macOS certificate is missing. A partial set is never
passed through, because electron-builder would fail the build on it. PR / push builds never sign; they
run the gate as a dry-run to keep the script working on all three runners.

中文：在仓库 Secrets 中配置上表名称。只有打 tag 的构建会读取；整组齐全才签名 / 公证，缺失或不完整时降级为未签名构建，不会让发布失败。

Unsigned builds still install and update; SmartScreen / Gatekeeper may warn until certificates are configured.

### Local signed build

```bash
CSC_LINK=./devid.p12 CSC_KEY_PASSWORD=… APPLE_ID=… APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=… \
  pnpm --filter @nomi-ai/host-electron run package:prod:mac
```

---

## Local package (emergency only · 仅本机应急)

> 正式包请走 CI。以下命令仅在对应 **原生 OS** 上应急自测；Linux 无法产出可用的 Win/Mac 离线 TTS 包。

前置：Node ≥ 22.12、pnpm 9（`COREPACK_HOME` 可指向缓存目录）、仓库根目录。

```bash
export COREPACK_HOME="${COREPACK_HOME:-$HOME/.cache/corepack}"
pnpm install --frozen-lockfile
pnpm turbo run build

# 打包（脚本名见 apps/desktop-electron/package.json）
pnpm package:prod:linux   # → dist/*.AppImage
pnpm package:prod:win     # → dist/Nomi Setup *.exe（须在 Windows）
pnpm package:prod:mac     # → dist/*.dmg + dist/*-mac.zip（x64/arm64；须在 macOS）
```

等价（只跑 electron 包）：

```bash
pnpm --filter @nomi-ai/host-electron run package:prod:win
pnpm --filter @nomi-ai/host-electron run package:prod:mac
pnpm --filter @nomi-ai/host-electron run package:prod:linux
```

## Local publish (maintainers)

```bash
pnpm install
pnpm turbo run build
GH_TOKEN=… pnpm --filter @nomi-ai/host-electron run package:publish:linux   # or :win / :mac
```

`electron-builder.yml` → `publish.provider: github` (owner `Cookieboty`, repo `nomi-ai`).

---

## Version matrix

| File                                                        | Role                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/desktop-electron/package.json` → `version`            | App version reported by `app.getVersion()` and written into installers |
| Git tag `vX.Y.Z`                                            | Must match that version (electron-builder / updater convention)        |
| `apps/desktop-electron/config/default.json` → `app.version` | Display/config default only — keep in sync when bumping                |

---

## Troubleshooting

- **Settings always “unavailable”** — you are on `pnpm dev` / unpackaged. Package and install first.
- **Check fails with 404** — no Release (or no `latest*.yml`) for a _newer_ version than the installed app.
  When the newest Release simply has no `latest*.yml` for this platform yet, the app shows
  "a new version is still being published" instead of an error (#146).
- **Download stalls** — corporate proxy; electron-updater uses HTTPS to `api.github.com` / release assets.
- **Install does nothing** — status must be `downloaded`; click **Restart and install** and confirm the dialog.
