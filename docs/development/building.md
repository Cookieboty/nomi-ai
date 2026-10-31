# 构建与运行

## 环境

- Node.js ≥ 22.12（`.nvmrc` 为 22，CI 使用 24），pnpm 9（通过 Corepack）
- Linux 运行 Electron 需要图形环境；无显示器时用 `xvfb-run -a`

```bash
corepack enable
pnpm install
```

## 开发

```bash
pnpm dev          # 先做环境自检，再启动主进程 + 两个渲染进程（热更新）
pnpm doctor       # 完整环境自检
pnpm dev:smoke    # 启动开发环境并确认窗口正常（CI 也会跑）
```

开发端口见根目录 `dev-ports.json`：

| 用途                 | 端口 | 覆盖变量           |
| -------------------- | ---- | ------------------ |
| 诺米窗口（renderer） | 6127 | `CD_RENDERER_PORT` |
| 对话窗口（ai-chat）  | 6128 | `CD_CHAT_PORT`     |
| demo                 | 6129 | `CD_DEMO_PORT`     |

## 检查

```bash
pnpm build          # 构建全部包
pnpm typecheck
pnpm lint
pnpm test           # 各包单元测试 + scripts 测试
pnpm check:i18n     # 统一词典的 key、语言、占位符和死 key 检查
pnpm check:licenses # 依赖与素材许可是否全部为开源许可
pnpm format:check   # Prettier 格式
```

## 打包

```bash
pnpm package                          # 当前平台安装包（会先构建依赖的包）
pnpm package:prod:mac | :win | :linux # 指定平台（需在对应系统上，CI 用这三个）
pnpm package:debug                    # 不打 asar 的调试包
```

产物在仓库根目录的 `dist/`，配置见 `apps/desktop-electron/electron-builder.yml`。安装包从 `packages/renderer/dist`、`packages/ai-chat/dist` 读取界面资源。签名、公证与发布流程见 [RELEASE.md](../RELEASE.md)。

不打包、直接运行构建产物：

```bash
pnpm build
pnpm --filter @nomi-ai/host-electron run launch:debug   # 复制界面资源到 apps/desktop-electron/dist 后启动
```

## 性能测量

```bash
xvfb-run -a node scripts/measure-startup.mjs 7   # 启动耗时
xvfb-run -a node scripts/measure-chat-open.mjs 7 # 打开对话窗口与设置页耗时
```

## 素材与验证脚本

| 脚本                                                                                  | 用途                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `scripts/brand/build-app-icon.py [输出目录]`                                          | 生成应用图标 SVG 变体（默认 `docs/brand/icon-variants`） |
| `electron scripts/brand/render-icons.mjs <jobs.json>`                                 | 用 Electron 把 SVG 栅格化为 PNG                          |
| `node apps/desktop-electron/internal/core/scripts/smoke-silero.cjs <silero_vad.onnx>` | 构建后验证主进程能加载 Silero VAD 推理                   |
| `python3 scripts/contact-sheet.py <目录> <输出.png>`                                  | 把截图拼成网格，便于检查动画                             |

Python 脚本需要 Pillow、NumPy、OpenCV。
