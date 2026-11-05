# Releasing Nomi · 发布指南

Nomi 的安装包（`apps/desktop-go`，Go 内核 + Wails v3）由
[`.github/workflows/desktop-go-package.yml`](../.github/workflows/desktop-go-package.yml) 构建并发布到
[GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases)。应用读 Release 里的
`latest-go.json`，下载新版并在用户点「重启更新」后安装（mac 用 `-mac.zip` 原地替换，Windows 静默安装，见
[自动更新](features/auto-update.md)）；
同一个 Release 还附 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`，给还装着 **2.0.4（Electron）** 的用户在应用内升级
（见下文「2.0.4 → 新版」）。2.2.0 起不再发布 Electron 版（`Nomi-Electron-*`），仓库里也已删除它的代码。

## 发布流程

| 事件                                 | 做什么                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| push `main`                          | `desktop-go.yml`（三平台 go vet / go test、构建）+ `ci.yml`（三平台 quality）；不打安装包                                                          |
| PR → `main`                          | `desktop-go.yml`（只改 Go / 视图 / 内核时）；带 `ci:full` 标签才打安装包                                                                           |
| push tag `v*`（≥ v2.0.5）            | **不重跑测试**（打 tag 前 main 上必须已全绿）→ 三平台打包 + 安装/启动验证 → `latest-go.json` → draft Release → 产物齐全后**自动发布**并标为 latest |
| `workflow_dispatch`（在 tag ref 上） | 补跑：`publish=true` 才发布                                                                                                                        |
| `workflow_dispatch`（在 `main` 上）  | 打一次 Go 安装包                                                                                                                                   |

发一版：

1. 改版本号（根目录 `package.json` 的 `version`，打包与 tag 校验都读它），写 `docs/releases/vX.Y.Z.md`。
   这份文件是更新说明的唯一来源：它是 GitHub Release 正文，也由 `update-manifest.py --notes` 写进该版本的
   `latest-go.json`（`releaseNotes`）。应用内「更新日志」弹层经 `updates.releaseNotes` 按版本号取
   `releases/download/vX.Y.Z/latest-go.json` 并缓存，界面里不内置任何版本的文案，发版不用改代码。
   每行写成「中文 / English」，弹层按界面语言取一半；只写给用户看的内容。
2. 在 `main` 上等 `desktop-go` 与 `CI` 都绿（tag 上不再重跑测试，直接打包发布）。

   发版分支（`release/X.Y.Z` → PR → `main`）怎么少等一轮：
   - 普通 PR 上 `CI` 只跑 Linux `quality` 与 `changeset status`；三平台 `quality` 要到 push `main` 才跑。`desktop-go` 在 PR 与
     `main` 上跑的是同一组任务。
   - 发版 PR 加 `ci:full` 标签：完整矩阵（含安装包打包与安装验证）在合并前就跑完。
   - 合并后先比较代码树：`git rev-parse <合并提交>^{tree}` 与 `git rev-parse <PR 最后一个提交>^{tree}` 相同（发版分支从当时的
     `main` 拉出、期间 `main` 没有新提交），说明合并后的代码就是 PR 测过的那份，PR 带 `ci:full` 全绿即可直接打 tag；
     树不同，或 PR 没带 `ci:full`，就等 `main` 上的 `CI` 与 `desktop-go` 跑完再打 tag。

3. 打 tag 并推送：`git tag -a vX.Y.Z -m "Nomi X.Y.Z" && git push origin vX.Y.Z`。
4. 等 `desktop-go-package` 跑完：Release 应有 `Nomi-X.Y.Z-arm64.dmg`、`Nomi-X.Y.Z-arm64-mac.zip`、`Nomi-X.Y.Z.dmg`、
   `Nomi-X.Y.Z-mac.zip`、`Nomi-Setup-X.Y.Z.exe`、`Nomi-X.Y.Z.AppImage`、`nomi_X.Y.Z_amd64.deb`、`latest-go.json`、`SHA256SUMS`、
   `latest.yml`、`latest-mac.yml`、`latest-linux.yml`。`release-draft` 检查这些文件齐全后把草稿发布为 latest。
   任一平台失败时 Release 停在 draft：修好后在该 tag 上手动重跑 `desktop-go-package`（勾选 `publish`）。

签名：mac 只做 Developer ID 签名，不公证；Windows 签 `Nomi.exe` 与安装器；都与 2.0.4 用同一组证书。mac 证书缺失时，分支构建
退化为 ad-hoc 并告警，**tag 发版直接失败**（2.0.4 不接受 ad-hoc 签名的更新）；Windows 证书缺失时不签名。仓库 Secrets
（Settings → Secrets and variables → Actions）：

| Secret                 | 用途                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `MAC_CSC_LINK`         | Developer ID Application 证书 `.p12` 的 base64（或 `https://` / `file://` 地址） |
| `MAC_CSC_KEY_PASSWORD` | 该 `.p12` 的密码                                                                 |
| `WIN_CSC_LINK`         | Authenticode 代码签名证书 `.pfx` / `.p12` 的 base64                              |
| `WIN_CSC_KEY_PASSWORD` | 该证书的密码                                                                     |

编码证书：`base64 -i cert.p12 | pbcopy`（macOS）或 `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`（PowerShell）。

### 2.0.4 → 新版（应用内升级）

2.0.4 用 electron-updater 6.8.9：读最新 Release 的 `latest*.yml` → 下载 → 校验 sha512 → 用户点「重启并安装」。
`packaging/update-manifest.py` 按 electron-builder 的格式生成这三个文件，指向 Go 版安装包：

| 平台    | 2.0.4 下载                   | 安装方式                                                                                                                                      |
| ------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | `Nomi-Setup-X.Y.Z.exe`       | 以 `--updated --force-run` 运行 Go 安装器：沿用 2.0.4 的目录与卸载项，先静默跑 2.0.4 卸载器（保留数据），装完自动启动；签过名时要求同一发布者 |
| macOS   | `Nomi-X.Y.Z[-arm64]-mac.zip` | Squirrel.Mac 替换 `Nomi.app`，要求新包满足 2.0.4 的签名要求（`com.cookieboty.nomi` + 同一 Team ID）                                           |
| Linux   | `Nomi-X.Y.Z.AppImage`        | 替换原 AppImage 文件后启动                                                                                                                    |

不出 blockmap：electron-updater 取不到 blockmap 时整包下载。用户数据由新版首次启动时迁移（`internal/migrate`）。

2.1.1 起 CI 不再验证这条升级路径（2.0.4 → 新版的应用内升级、electron-updater 解析 `latest*.yml`、Squirrel.Mac 签名标识、
与 2.0.4 的 Info.plist 对比都已去掉）：`latest*.yml` 照常生成，但不保证 2.0.4 能升级成功。`verify` 只验证新安装包本身
（安装、启动、桌面角色窗口），`manifest` 只校验应用自己读的 `latest-go.json`。
