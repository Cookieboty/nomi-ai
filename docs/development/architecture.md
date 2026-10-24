# 架构概览

Nomi 是一个 pnpm + Turborepo monorepo，桌面端基于 Electron，界面为 React 19 + Vite。

## 进程与窗口

```
Electron 主进程（packages/electron）
 ├─ 看板娘窗口（packages/renderer）    透明置顶，Nomi 与工具栏
 ├─ 对话窗口（packages/ai-chat）      对话、设置、各功能面板
 └─ 辅助窗口                          截图遮罩、灵动岛、受控浏览器、TTS 配置
```

- 入口 `packages/electron/src/main.ts` → `core/Application.ts`；窗口由 `WindowManager` 管理。
- 所有窗口开启上下文隔离与沙箱；页面只能通过 preload 暴露的**具名白名单**接口访问主进程（AI 能力为 `window.aiIPC`）。
- IPC 通道命名为 `'<领域>:<动作>'`；`ai:*` 调用会经 `security/ipcSenderGuard.ts` 校验发送方。

## 包

| 包                                                                | 作用                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `electron`                                                        | 主进程：窗口、托盘、IPC、各功能服务（桌面能力、知识库、记忆、日程、本机管理、屏幕记忆、更新、灵动岛……）                                                            |
| `renderer`                                                        | 看板娘窗口：角色渲染（`src/mascot`）、气泡、工具栏                                                                                                                 |
| `ai-chat`                                                         | 对话窗口：对话、设置、引导与功能面板                                                                                                                               |
| `ai-runtime`                                                      | AI 运行时：插件宿主、基于 Vercel AI SDK 的供应商路由（`src/providers`）、MCP 桥（`src/ai-sdk/mcpBridge.ts`）                                                       |
| `gateway`                                                         | 统一网关内核（纯 Node，不依赖 Electron）：Messages / Responses / Chat / Gemini 的请求 IR 与流式互转；主进程的本地路由服务在用                                      |
| `cli-sdk`                                                         | 编程助手插件契约（清单、能力接口）与共享会话驱动 acp / stream-json / app-server / exec（纯 Node，不依赖 Electron），见 `docs/design/cli-plugin-architecture.md` §5 |
| `ai-sdk`                                                          | 主进程侧 AI 门面（`AIClient`）                                                                                                                                     |
| `ai-sdk-client`                                                   | 渲染进程侧客户端与 preload 桥                                                                                                                                      |
| `bundle-ig-base` / `bundle-ig-electron-caps` / `bundle-ig-mascot` | 插件包：基础能力（不得依赖 electron）/ Electron 能力 / 看板娘能力                                                                                                  |
| `ui`                                                              | 设计令牌、4 套主题、通用组件、i18n（`src/locales/en.json`）                                                                                                        |
| `voice`                                                           | 语音输入、VAD、唤醒词                                                                                                                                              |
| `types`                                                           | 共享类型                                                                                                                                                           |

## 关键约定

- **数据**：全部保存在 Electron `userData` 下按功能划分的目录；密钥使用 `safeStorage`。
- **网络**：外部请求经 `netGuard` 拦截本机 / 内网地址；执行命令使用 `shellEscape`；私有文件经 `utils/privateFile` 以 0600 写入。
- **日志**：主进程使用 `LoggerService` / `createMainLogger`，渲染进程使用 `@nomi-ai/ui` 的 `createLogger`，不直接用 `console.log`。
- **界面**：CSS Modules + `var(--cd-*)` 设计令牌；功能面板懒加载；看板娘 Rive 场景按需加载。
- **i18n**：界面文案以中文原文为 key，英文翻译在 `packages/ui/src/locales/en.json`；渲染进程用 `t()`，主进程用 `packages/electron/src/i18n`。
