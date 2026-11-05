# Nomi 桌面应用（apps/desktop-go）

Nomi 的桌面应用：Go 内核 + [Wails v3](https://v3.wails.io) 外壳。视图是 `packages/renderer`（桌面角色窗口）与
`packages/ai-chat`（对话窗口），构建产物内嵌进 Go 程序。2.2.0 起 Electron 版（Node 内核）已删除，这里是唯一的桌面应用。

- 视图经契约（`@nomi-ai/contract`）调用内核，Go 的契约过程表由 TS 契约生成（`internal/contract/gen`）。
- 架构总览见 [`docs/development/architecture.md`](../../docs/development/architecture.md)。

## 环境要求

- 仓库根目录先 `pnpm install`（视图与工作区包由 pnpm / turbo 构建）
- Go（版本见 `go.mod`）与 cgo 工具链：
  - macOS：Xcode Command Line Tools
  - Windows：PATH 里有 gcc（如 MSYS2 mingw-w64）
  - Linux：GTK3 与 WebKitGTK 4.1 开发包（Debian / Ubuntu：`libgtk-3-dev libwebkit2gtk-4.1-dev`）
- 构建标签：macOS 必须加 `-tags private_mac_apis`（否则诺米窗口不透明），Linux 加 `-tags gtk3`；下面的脚本已经带上

## 开发

视图热更新（仓库根目录）：

```bash
pnpm dev                 # Vite 开发服务器 + Go 程序；改 renderer / ai-chat 源码即热更新
pnpm dev --skip-deps     # 跳过构建视图依赖的工作区包；改了这些包时另开终端 pnpm dev:libs
```

改 Go 代码（含内嵌的 locales / json）会自动重新编译并重启 Go 程序（视图服务器不动）；编译失败时旧进程继续跑。
退出应用即结束开发态。视图的 console 输出与未捕获错误会以 `[view mascot]` / `[view chat]` 打到终端
（WebView 默认没有检查器）。

按生产方式构建并启动（视图打包后嵌进程序）：

```bash
apps/desktop-go/run-dev.sh    # macOS / Linux
apps\desktop-go\run-dev.cmd   # Windows（不加 -H windowsgui，保留控制台看日志）
```

`SKIP_FRONTEND=1` 跳过视图（只改了 Go 代码时），`SKIP_BUILD=1` 直接复制 renderer / ai-chat 现有的 dist；
其余参数原样传给程序。

## 视图与宿主

- `frontend/build.mjs` 跑 turbo build，把 `packages/renderer/dist`、`packages/ai-chat/dist` 原样复制到
  `frontend/dist/{mascot,chat}`，由 `main.go` 的 `//go:embed` 嵌进程序。
- 视图从页面地址片段里读宿主给的 WebSocket 地址与一次性 token，经 WebSocket 连 Go 内核
  （`services/api.ts` → `installGoHostTransport`，只认 `ws://127.0.0.1`）。token 每个窗口一份（每次新建 / 重建都换新的），
  内核记 token → 界面，调用方的界面按 token 认，子协议里自报的界面与之不符直接拒绝握手；
  窗口关闭时撤销它的 token 并断开连接（`internal/contract/websocket.go` `WSServer.Issue`）。
- Go 提供页面时（`internal/shell/viewpage`）给 CSP 的 connect-src 加上 `ws://127.0.0.1:*`，并插入 Wails 运行时
  `/wails/runtime.js`（标题栏拖动、文件拖放依赖它）。
- `chat-asset://`、`character-pack://` 经资产服务器网关 `/__scheme/<scheme>/…` 提供（Wails 只接管 `wails` scheme）。
- 灵动岛页由 Go 直接生成（`internal/core/island`）。

## 目录

| 路径                                                                        | 内容                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `main.go`、`*_wiring.go`                                                    | 组合根：创建各服务、注册契约过程、启动外壳                                                       |
| `internal/contract`                                                         | 契约路由、WebSocket 传输；`gen/` 是由 TS 契约生成的过程表与类型（勿手改）                        |
| `internal/core`                                                             | 业务模块（不依赖 Wails）；契约处理函数在 `<域>handlers`                                          |
| `internal/ai`、`internal/gateway`、`internal/clisdk`、`internal/cliplugins` | AI 运行时、统一网关、编程助手驱动与插件                                                          |
| `internal/shell`                                                            | 外壳接口；`wailsshell/` 是唯一依赖 Wails 的包；`viewpage/`、`devviews/` 是视图页面改写与开发代理 |
| `internal/migrate`                                                          | 首次启动从旧的 Electron 版迁移用户数据（文件、聊天记录、密钥）                                   |
| `frontend/`                                                                 | 视图构建脚本与嵌入目录（`dist/` 不入库）                                                         |
| `packaging/`                                                                | 三平台打包（`package.sh`、NSIS 安装器、AppImage / deb、更新清单）                                |
| `assets/`、`character-pack-resources/`                                      | 只读资源：应用 / 托盘图标、背景等（打包进 resources）                                            |
| `ci/`                                                                       | Go 测试、安装包校验、性能与内存实测脚本                                                          |
| `dev.mjs`                                                                   | `pnpm dev` 的实现                                                                                |

## 测试

```bash
cd apps/desktop-go
go vet -tags private_mac_apis ./...     # Linux 用 -tags gtk3，Windows 不加
go test -tags private_mac_apis ./...
```

- 契约：`node scripts/go-contract/gen.mjs` 从 TS 契约重新生成 `internal/contract/gen`，`--check` 检查是否漂移（CI 里跑）。
- 仓库内路径用 `internal/repotest` 的 `RepoPath`；假模型在 `internal/mockllm`，假 CLI 在仓库根目录 `scripts/mock-cli`。
- 词典：`internal/core/i18n/locales` 是 `packages/i18n/src/locales` 的副本，`dict_test.go` 比对两份。
- CI：`.github/workflows/desktop-go.yml`（构建与测试）、`desktop-go-package.yml`（三平台打包、安装校验、可选性能对比 `bench=true`）。

## 打包

```bash
apps/desktop-go/packaging/package.sh mac-arm64   # mac-x64 | windows | linux
```

只在对应平台上跑（mac x64 由 arm64 交叉编译）。产物在 `apps/desktop-go/dist-pkg/`，文件名沿用 2.0.4 的 electron-builder 命名
（`Nomi-<版本>-arm64.dmg`、`Nomi-Setup-<版本>.exe`、`Nomi-<版本>.AppImage`、`nomi_<版本>_amd64.deb` 等）。
版本号默认读仓库根目录 `package.json`（`NOMI_VERSION` 覆盖）；`MAC_SIGN_IDENTITY` 非空时用 Developer ID 签名（不公证）。

自动更新：读 Release 里的 `latest-go.json`（`packaging/update-manifest.py` 生成），下载并校验 SHA-256；用户点「重启更新」后
mac 原地替换 Nomi.app 并重新打开（`-mac.zip`，校验签名与 Team ID），Windows 静默运行安装器，Linux 替换 AppImage。
见 [docs/features/auto-update.md](../../docs/features/auto-update.md)。

## 用户数据

| 平台    | 目录                                             |
| ------- | ------------------------------------------------ |
| macOS   | `~/Library/Application Support/Nomi`             |
| Windows | `%APPDATA%\Nomi`                                 |
| Linux   | `$XDG_CONFIG_HOME/Nomi`（默认 `~/.config/Nomi`） |

与旧 Electron 版的目录（`@nomi-ai/electron`）分开。首次启动时把旧版的数据**复制**过来（不改、不删原目录）；
已保存的 API Key 在第一个窗口出来后从旧版的 safeStorage 迁到系统钥匙串。

## 环境变量

| 变量                                     | 作用                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `NOMI_USER_DATA` / `NOMI_APP_DATA`       | 覆盖 userData / 应用数据根目录（测试与迁移用）                          |
| `NOMI_RESOURCES` / `NOMI_CHARACTER_PACK` | 覆盖只读资源目录 / 内置角色包目录（打包后默认取安装目录里的）           |
| `NOMI_DEV_VIEWS`                         | 视图改由 Vite 开发服务器提供（`pnpm dev` 自动设置）                     |
| `NOMI_POC_CTL`                           | 测量 / CI 用的本机控制口（`/ctl?op=show-chat` 等，见 `main.go` 文件头） |
| `WEBKIT_DISABLE_DMABUF_RENDERER`         | Linux 默认设为 `1`（省内存）；显式设置时以设置值为准                    |

编程助手、网关等模块另有 `NOMI_*` 变量（如 `NOMI_CLAUDE_BIN`、`NOMI_GATEWAY_*`、`NOMI_USE_MOCK_CLI`）。
