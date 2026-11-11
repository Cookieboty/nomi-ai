# 构建与运行

## 环境

- Node.js ≥ 22.12（`.nvmrc` 为 22，CI 使用 24），pnpm 9（通过 Corepack）
- Go（版本见 `apps/desktop-go/go.mod`；`GOTOOLCHAIN=auto` 时会自动下载）与 cgo 工具链；Linux 另需 GTK3 与 WebKitGTK 4.1 开发包
  （`sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev`）

```bash
corepack enable
pnpm install
```

## 开发

```bash
pnpm dev          # 先做环境自检，再启动两个视图的 Vite 开发服务器与 Go 程序（视图热更新，改 Go 代码自动重编译重启）
pnpm doctor       # 完整环境自检（Node、pnpm、Go、端口）
pnpm dev:libs     # 另开终端：改 contract / ui 等共享包时监听重建
```

细节（参数、`--skip-deps`、开发态的视图代理）见 [apps/desktop-go/README.md](../../apps/desktop-go/README.md)。

开发端口见根目录 `dev-ports.json`：

| 用途                 | 端口 | 覆盖变量           |
| -------------------- | ---- | ------------------ |
| 诺米窗口（renderer） | 6127 | `CD_RENDERER_PORT` |
| 对话窗口（ai-chat）  | 6128 | `CD_CHAT_PORT`     |
| demo                 | 6129 | `CD_DEMO_PORT`     |

## 检查

```bash
pnpm build          # 构建视图与共享包
pnpm typecheck
pnpm lint
pnpm test           # 各包单元测试 + scripts 测试
pnpm check:i18n     # 统一词典的 key、语言、占位符和死 key 检查（含 Go 源码里用到的 key）
pnpm check:licenses # 依赖与素材许可是否全部为开源许可
pnpm format:check   # Prettier 格式
cd apps/desktop-go && go vet ./... && go test ./...   # macOS 加 -tags private_mac_apis，Linux 加 -tags gtk3
```

## 打包

```bash
pnpm package mac-arm64 | mac-x64 | windows | linux   # = bash apps/desktop-go/packaging/package.sh <平台>
```

只能在对应平台上打（mac 的 x64 由 arm64 交叉编译）。脚本先构建视图（`apps/desktop-go/frontend/build.mjs`，`SKIP_FRONTEND=1`
跳过），产物在 `apps/desktop-go/dist-pkg/`；版本号读根目录 `package.json`（`NOMI_VERSION` 覆盖）。签名与发布流程见
[RELEASE.md](../RELEASE.md)。

## 素材与验证脚本

| 脚本                                                 | 用途                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `scripts/brand/build-app-icon.py [输出目录]`         | 生成应用图标 SVG 变体（默认 `docs/brand/icon-variants`）   |
| `scripts/brand/build-icon-assets.py`                 | 栅格化并打包应用图标 / 托盘图标到 `apps/desktop-go/assets` |
| `python3 scripts/contact-sheet.py <目录> <输出.png>` | 把截图拼成网格，便于检查动画                               |

Python 脚本需要 Pillow、NumPy、OpenCV。
