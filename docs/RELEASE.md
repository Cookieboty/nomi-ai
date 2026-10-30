# Releasing Nomi · 发布指南

Nomi ships installers for **Windows (NSIS)**, **macOS (DMG, x64+arm64)** and **Linux (AppImage)** via
[electron-builder](https://www.electron.build/), published to
[GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases). Installed apps update through
`electron-updater` (same feed).

## Formal installers · 正式安装包以 CI 为准

**品牌官 / 用户拿到的 Win NSIS、Mac DMG、Linux AppImage，一律以 GitHub Actions artifact 或 tag 触发的 GitHub Release 为准。**

| 来源                                                                     | 用途                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `CI` → job `build-electron` → artifact `installer-{linux,mac,win}-<sha>` | push main / 带 `ci:full` 的 PR / `workflow_dispatch` 的可安装包（未签名也可测） |
| tag `v*` → 同 job + `package:publish:*` → job `publish-release`          | 先传到草稿 Release，三平台齐了再发布，供 `electron-updater` 使用                |

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
