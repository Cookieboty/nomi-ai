# 测试

| 层级         | 位置                                       | 运行                   | 跑什么                                                                                                          |
| ------------ | ------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| 单元测试     | `packages/*/src/**`、`packages/*/tests/**` | `pnpm test`            | 各包逻辑；`electron` 用 Jest（`packages/electron/tests/unit`），其余包用 Vitest                                 |
| 脚本测试     | `scripts/__tests__`                        | `pnpm test:root`       | changelog 与签名环境脚本                                                                                        |
| 无界面 E2E   | `e2e/tests`                                | `pnpm test:e2e`        | 不启动 Electron：真实 `AIClient` + IPC 服务端 + 事件广播，配合假的 IPC / LLM / 工具，验证跨窗口的调用与事件契约 |
| 真实应用 E2E | `e2e-headed/tests`                         | `pnpm test:e2e:headed` | Playwright 启动真实 Electron，操作界面                                                                          |

## 无界面 E2E（`e2e/`，Vitest，4 个文件 / 11 个用例）

- `E1.waifu-tts-lipsync`：TTS 分片与回合结束事件广播到看板娘窗口
- `E2.chat-only-send-and-tool`：对话窗口发消息、工具执行事件、工具列表
- `E4.waifu-profile-write-read`：用户档案写入后广播到多个窗口，下一次对话读到最新值
- `E5.write-file-confirm`：危险工具 `write_file` 需要确认，拒绝后不执行并返回 `E_TOOL_DENIED`

## 真实应用 E2E（`e2e-headed/`，Playwright，21 个文件 / 23 个用例）

看板娘与内置 2D 角色 Nomi（E1、E4、E15、E22、E23）、对话与历史（E2、E6）、MCP（E3）、整机冒烟（E5）、供应商（E7）、互动（E9）、桌面能力（E10）、气泡安全与工具栏（E11、E12）、笔记 / 提醒 / 剪贴板（E13）、引导与语言（E14、E16）、无障碍（A11Y）、快捷键与命令面板（KEYS）、英文界面（I18N）、界面截图（UI、ANIM）。

```bash
# 在仓库根目录运行（先 pnpm build && pnpm --filter @nomi-ai/electron run copy-renderer）
xvfb-run -a pnpm test:e2e:headed
```

`playwright.config.ts` 固定界面语言为中文（`CD_LOCALE=zh-CN`），默认关闭首次引导（`CD_ONBOARDING=off`），并关闭离线语音合成（`CD_TTS=off`）。所有用例都使用内置 2D 角色 Nomi（Rive，起不来时回退到分层 2D sprite），不下载任何测试模型。

## 为什么是两套 E2E

两套测的是不同层，没有可以删掉的重复：

- `e2e/` 用假的 LLM 与工具在进程内验证 IPC 契约（事件名、广播范围、拒绝路径的错误码），结果确定、不需要网络与 Electron。这些断言在真实应用里拿不到（没有可控的模型输出），真实应用 E2E 也没有覆盖 `write_file` 拒绝路径和 TTS 分片广播。
- `e2e-headed/` 验证用户真正看到和操作的界面，需要 Electron 与显示环境。
- 合并到同一个 Playwright 配置需要把 Vitest 用例改写为 Playwright 的 test/expect，收益只是少一个配置文件。
- CI 里无界面 E2E 每个平台 1–2 分钟，真实应用 E2E 5–9 分钟；分成两个 job 可以并行，先给出快速信号。

## 网关回放夹具（`packages/gateway/tests/fixtures/replay/`）

把真实遇到的第三方上游问题固化成回归测试：诊断日志打开时网关会写追踪文件（`userData/gateway/trace/*.json`，含入口请求体、上游原始响应全文、给客户端输出的差异），用脚本转成脱敏夹具：

```bash
pnpm -F @nomi-ai/gateway exec tsx scripts/trace-to-fixture.ts <trace.json>... [--name 名字] [--keep-text]
```

- 默认去掉对话正文（正文类字段的非空字符串换成 `[text]`，结构不变；空字符串保留，保活靠 `delta: ''` 识别），并再脱敏一遍；不带任何请求头。工具参数（`arguments`、`partial_json`、参数对象）保留，里面可能有文件内容，**提交前自己看一遍**。`--keep-text` 保留正文（只用于本地排查，不要提交）。
- 回放的是最后一次上游尝试；SSE 按事件切块逐块写出，截断在半截的事件原样保留（其中的正文字符串同样换掉）。
- `tests/replay.test.ts` 对每个夹具：起一个按块回放的假上游，经 `createGateway` 发出录下的请求，断言给客户端的输出通过入口协议的规范校验（`src/spec`）、以结束或失败事件收尾，并对去掉 id / 时间戳的事件做快照；提交前就失败的（一个内容事件都没有）断言是 HTTP 错误。
- 仓库里现有的 4 个夹具是用已有测试场景合成的（`"synthetic": true`），不是真实流量。

## 性能基准与体积预算

先 `pnpm build && node packages/electron/scripts/copy-renderer.js`，Linux 无显示器时前面加 `xvfb-run -a`：

```bash
node scripts/measure-session-switch.mjs [--scenario nomi|cli] [--cpu 4]   # 切换会话：点击 → 内容绘制耗时、长任务、主线程脚本 / 布局
node scripts/measure-stream-render.mjs [--chars 8000] [--cps 320]         # 流式输出长代码块：主线程忙碌占比、渲染次数
node scripts/check-bundle-budget.mjs [--strict]                           # 首屏 JS / CSS 体积预算（scripts/bundle-budgets.json）
```

体积预算按 `dist/index.html` 的入口 script + modulepreload + stylesheet 统计，并禁止语法高亮器出现在首屏 chunk。CI 里只报告（`::warning` 注解 + job summary，`continue-on-error`），不会变红；加 `--strict` 才失败。调高预算要在 PR 里写明原因。

## CI

`.github/workflows/ci.yml`（什么事件跑哪些 job 见 [CI 触发规则](ci.md)：普通 PR 只跑 Linux quality + changeset，带 `ci:full` 标签才跑完整矩阵）：

- `quality`（Ubuntu / Windows / macOS）：许可、i18n、typecheck、lint、单元测试、构建；Ubuntu 上追加首屏体积预算报告（不阻塞）
- `e2e-headless`、`e2e-headed`（Ubuntu / Windows）
- `dev-smoke`（Ubuntu）
- `changeset status`
- `build-electron`（三平台打包）
