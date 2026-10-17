# Grok Build CLI 接入

> 状态：已实现（2026-10-16）。包名 `@xai-official/grok` / 命令 `grok`；家目录 `GROK_HOME` 或 `~/.grok`。

## 调研结论（公开文档）

| 能力     | 结论                                                                                                                      | 来源                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Headless | `grok -p "…" --output-format streaming-json`（另有 `plain` / `json`）                                                     | [docs.x.ai headless](https://docs.x.ai/build/cli/headless-scripting) |
| 会话     | `--resume` / `-c` / `-s`；磁盘 `~/.grok/sessions/<cwd>/<uuid>/`                                                           | 同上 + Sessions 文档                                                 |
| 自更新   | `grok update`；亦可 `npm i -g @xai-official/grok@latest`                                                                  | CLI / npm                                                            |
| 供应商   | `~/.grok/config.toml` 的 `[model.*]` + `api_backend`（`responses` / `chat_completions` / `messages`）；密钥可用 `env_key` | docs.x.ai/build/settings                                             |
| 鉴权     | `XAI_API_KEY` 或 CLI 登录写入的 `auth.json`（**Nomi 不读凭据内容**）                                                      | 公开文档                                                             |
| 用量日志 | `sessions/**/updates.jsonl` 中 `sessionUpdate == "turn_completed"` + `usage`（input 含缓存）                              | 社区 ccusage / 公开会话布局；**字段名未用真机二进制逐条核对**        |
| 订阅额度 | 无安全、已文档化的只读额度 API 可接入                                                                                     | **暂不支持额度卡**                                                   |

硬约束：不读凭据、不调未文档接口、不碰看板娘 rig 动画内部。

## Nomi 实现对照

- **探测 / 安装**：`CliUpdateService` 白名单 `grok update` + npm `@xai-official/grok@latest`；`detect` 搜索 `~/.grok/bin` 等。
- **Harness**：`CliHarnessService.runGrok` — `-p`、`streaming-json`、`--no-auto-update`、`--yolo`、可选 `--resume` / `--cwd`；流解析 `parseGrokLine`。
- **供应商**：独立 `cli-providers/grok/store.json`；启用时 `patchGrokToml` 写标记区块 + `env_key = NOMI_GROK_API_KEY`（密钥仅启动时注入）。
- **监视**：`updates.jsonl` mtime；进程名 `grok`。
- **用量**：`parseGrokChunk` 读 `turn_completed`；额度按 API 计费展示。
- **历史侧栏**：本轮**未**接入（transcript 形状未真机核对）。

## 未验证项

1. 真机 `updates.jsonl` 字段名与嵌套（`params.update` vs 顶层）是否与测试夹具完全一致。
2. `costUsdTicks` / 长上下文计价边界。
3. Windows `.cmd` 垫片与 `grok update` 行为。
4. ACP `grok agent stdio`（本轮仅 headless `-p`）。
