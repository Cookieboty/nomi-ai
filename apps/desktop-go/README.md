# Nomi · Go 版（apps/desktop-go）

Nomi 桌面应用的 Go 版：Go 内核 + [Wails v3](https://v3.wails.io) 外壳。与 Node 版（Electron，`apps/desktop-electron`）**并存**，
两个版本共用同一套视图（`packages/renderer` 看板娘窗口、`packages/ai-chat` 对话窗口），功能保持一致。

- 内核由 TS 内核（`apps/desktop-electron/internal/core`、`ai-runtime`、`gateway`、`cli-sdk` 等）逐模块移植，分层与模块边界一一对应；
  行为一致由 parity 测试守住（Node 现场录制 golden，Go 回放比对）。
- 视图经契约（`@nomi-ai/contract`）调用内核，Go 的契约过程表由 TS 契约生成。
- 与 Node 版的全部差异（平台限制、尚未实现的能力）登记在
  [`docs/design/migrate-2.0.5-go.md`](../../docs/design/migrate-2.0.5-go.md) 的偏差表。

## 环境要求

- 仓库根目录先 `pnpm install`（视图与工作区包由 pnpm / turbo 构建）
- Go（版本见 `go.mod`）与 cgo 工具链：
  - macOS：Xcode Command Line Tools
  - Windows：PATH 里有 gcc（如 MSYS2 mingw-w64）
  - Linux：GTK3 与 WebKitGTK 4.1 开发包（Debian / Ubuntu：`libgtk-3-dev libwebkit2gtk-4.1-dev`）
- 构建标签：macOS 必须加 `-tags private_mac_apis`（否则看板娘窗口不透明），Linux 加 `-tags gtk3`；下面的脚本已经带上

## 开发

视图热更新（仓库根目录）：

```bash
pnpm dev:go              # Vite 开发服务器 + Go 程序；改 renderer / ai-chat 源码即热更新
pnpm dev:go --skip-deps  # 跳过构建视图依赖的工作区包；改了这些包时另开终端 pnpm dev:libs
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

- `frontend/build.mjs` 跑与 Node 版相同的 turbo build，把 `packages/renderer/dist`、`packages/ai-chat/dist` 原样复制到
  `frontend/dist/{mascot,chat}`，由 `main.go` 的 `//go:embed` 嵌进程序。没有任何 Go 专用的构建开关。
- 视图运行时识别宿主：没有 preload 桥、页面地址片段里有宿主给的 WebSocket 地址与一次性 token 时，经 WebSocket 连 Go 内核
  （`services/api.ts`，只认 `ws://127.0.0.1`）。
- Go 提供页面时（`internal/shell/viewpage`）给 CSP 的 connect-src 加上 `ws://127.0.0.1:*`，并插入 Wails 运行时
  `/wails/runtime.js`（标题栏拖动、文件拖放依赖它）。
- `chat-asset://`、`character-pack://` 经资产服务器网关 `/__scheme/<scheme>/…` 提供（Wails 只接管 `wails` scheme）。
- 灵动岛页由 Go 直接生成（`internal/core/island`）。

## 目录

| 路径                                                                        | 内容                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `main.go`、`*_wiring.go`                                                    | 组合根：创建各服务、注册契约过程、启动外壳（对应 Node 版的 `createCore` + 宿主 `Application`）   |
| `internal/contract`                                                         | 契约路由、WebSocket 传输；`gen/` 是由 TS 契约生成的过程表与类型（勿手改）                        |
| `internal/core`                                                             | 业务模块（不依赖 Wails），与 `apps/desktop-electron/internal/core` 一一对应                      |
| `internal/ai`、`internal/gateway`、`internal/clisdk`、`internal/cliplugins` | AI 运行时、统一网关、编程助手驱动与插件                                                          |
| `internal/shell`                                                            | 外壳接口；`wailsshell/` 是唯一依赖 Wails 的包；`viewpage/`、`devviews/` 是视图页面改写与开发代理 |
| `internal/migrate`                                                          | 首次启动从 Node 版迁移用户数据（文件、聊天记录、密钥）                                           |
| `frontend/`                                                                 | 视图构建脚本与嵌入目录（`dist/` 不入库）                                                         |
| `packaging/`                                                                | 三平台打包（`package.sh`、NSIS 安装器、AppImage / deb、更新清单）                                |
| `ci/`                                                                       | 安装包校验、性能与内存实测脚本                                                                   |
| `dev.mjs`                                                                   | `pnpm dev:go` 的实现                                                                             |

## 测试

```bash
cd apps/desktop-go
go vet -tags private_mac_apis ./...     # Linux 用 -tags gtk3，Windows 不加
go test -tags private_mac_apis ./...
```

- 契约：`node scripts/go-contract/gen.mjs` 从 TS 契约重新生成 `internal/contract/gen`，`--check` 检查是否漂移（CI 里跑）。
- Parity：`scripts/parity/record-*.mjs` 用 Node 版现场录制 golden（`pnpm exec tsx scripts/parity/<脚本>`），Go 测试回放比对；
  CI 在 macOS / Windows / Linux 三个平台各自录制。部分 golden 与平台相关（如代码沙箱：Linux 是 bwrap、macOS 是 sandbox-exec），
  在录制平台之外跑会不一致。
- CI：`.github/workflows/desktop-go.yml`（构建与测试）、`desktop-go-package.yml`（三平台打包、安装校验、可选性能对比 `bench=true`）。

## 打包

```bash
apps/desktop-go/packaging/package.sh mac-arm64   # mac-x64 | windows | linux
```

只在对应平台上跑（mac x64 由 arm64 交叉编译）。产物在 `apps/desktop-go/dist-pkg/`，文件名与 Node 版一致
（`Nomi-<版本>-arm64.dmg`、`Nomi-Setup-<版本>.exe`、`Nomi-<版本>.AppImage`、`nomi_<版本>_amd64.deb` 等）。
版本号默认读 `apps/desktop-electron/package.json`（`NOMI_VERSION` 覆盖）；`MAC_SIGN_IDENTITY` 非空时用 Developer ID 签名（不公证）。

自动更新：读 Release 里的 `latest-go.json`（`packaging/update-manifest.py` 生成），提示新版本并引导手动下载，不自动替换安装。

## 用户数据

| 平台    | 目录                                             |
| ------- | ------------------------------------------------ |
| macOS   | `~/Library/Application Support/Nomi`             |
| Windows | `%APPDATA%\Nomi`                                 |
| Linux   | `$XDG_CONFIG_HOME/Nomi`（默认 `~/.config/Nomi`） |

与 Node 版的目录（`@nomi-ai/electron`）分开，两个版本可以同时安装。首次启动时把 Node 版的数据**复制**过来（不改、不删原目录）；
已保存的 API Key 在第一个窗口出来后从 Node 版的 safeStorage 迁到系统钥匙串。

## 环境变量

| 变量                                     | 作用                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `NOMI_USER_DATA` / `NOMI_APP_DATA`       | 覆盖 userData / 应用数据根目录（测试与迁移用）                          |
| `NOMI_RESOURCES` / `NOMI_CHARACTER_PACK` | 覆盖只读资源目录 / 内置角色包目录（打包后默认取安装目录里的）           |
| `NOMI_DEV_VIEWS`                         | 视图改由 Vite 开发服务器提供（`pnpm dev:go` 自动设置）                  |
| `NOMI_POC_CTL`                           | 测量 / CI 用的本机控制口（`/ctl?op=show-chat` 等，见 `main.go` 文件头） |
| `WEBKIT_DISABLE_DMABUF_RENDERER`         | Linux 默认设为 `1`（省内存）；显式设置时以设置值为准                    |

编程助手、网关等模块沿用 Node 版的 `NOMI_*` 变量（如 `NOMI_CLAUDE_BIN`、`NOMI_GATEWAY_*`），含义相同。
