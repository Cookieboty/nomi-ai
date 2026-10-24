# 实施计划：编程助手插件化与网关分层适配

> 依据：[设计稿](../design/cli-plugin-architecture.md)（下称「设计」，引用写作 §x.y）。起草 2026-10-24。
> 范围：设计的全部内容（「满血版本」），包括设计 §11 里标为「推迟」的 L1 声明式外部插件与核心目录字面量 lint。
> 约定：每个阶段结束时 `pnpm typecheck && pnpm lint && pnpm test` 全部通过；不提交（用户要求），阶段结果记在本文件末尾的进度表里。

## 0. 总体顺序与依赖

```
P0  基线与回归防护 ─┬─► P1 推理意图止血 ──────────────────────────────┐
                    ├─► P2 官方账号目录化（v1.2.0） ─────────────────┐ │
                    ├─► P3 诊断日志 ───────────────────────────────┐ │ │
                    └─► P4 网关：规范化 + 协议桥 ─► P5 供应商规格 ─► P6 客户端规格与绑定
                                                                    └─► P7 模型规格与路由计划（3 步）
P2、P6 ─► P8 cli-sdk 与共享驱动 ─► P9 内置插件 ─► P10 外部声明式插件 + lint
全部 ─► P11 真实 CLI 一致性测试扩全 · 文档 · changeset
```

- P0 先做：后面每个阶段都靠它判断「有没有改坏」。
- P1、P2、P3、P4 互不依赖，按风险与用户优先级排：P1（小、用户可见的缺陷）→ P2（本版本必须发布）→ P4 → P3。
- P4～P7 是网关内部的连续重构，按顺序做。
- P8～P10 依赖 P2（账号契约）与 P6（客户端规格的形状）。

## P0 基线与回归防护（设计 §9.3、§9.5、M1a）

**目标**：重构之前先把「现在能用的行为」固化成测试。

| #    | 任务                                                                                                                                                                        | 位置                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| P0.1 | 记录基线：全量 `pnpm test`、`typecheck`、`lint` 的结果；已知失败（`cliSearchPath.test.ts` 的 Windows 用例）登记在案                                                         | 本文件进度表                                                          |
| P0.2 | 真实 CLI 一致性测试骨架 `e2e-cli/`：脚本化假上游（场景表驱动）+ 网关（真实构建，进程内启动）+ 本机已安装的 CLI 二进制（`grok -p`、`codex exec`、`claude -p`）；未安装的跳过 | `e2e-cli/harness.ts`、`e2e-cli/upstream.ts`、`e2e-cli/scenarios/*.ts` |
| P0.3 | 场景：附录 B 的流式用例（保活、缺字段、未知事件、截断、只给完整条目、辅助请求模型）                                                                                         | `e2e-cli/scenarios/`                                                  |
| P0.4 | 必填字段探测器：对一个 CLI 逐个删除字段 / 注入事件，输出「要求表」，与快照比对                                                                                              | `e2e-cli/probe.ts`、`e2e-cli/snapshots/grok-1.0.67.json`              |
| P0.5 | 来源隔离测试 S1～S6 的第一版（基于现有代码）：第三方启动不写全局目录、官方环境无网关残留、第三方环境无官方变量、网关拒绝官方格式 Bearer、换官方账号不影响第三方标签         | `packages/electron/tests/unit/isolation/*.test.ts`                    |

**验收**：`pnpm test:e2e-cli`（新脚本）在本机通过；S1～S6 测试通过。

## P1 推理意图止血（设计 §6.9.5，M0.5）

**目标**：跨协议时推理强度不再丢失（MA1）。在现有结构上实现，P7 再重构进模型适配器。

| #    | 任务                                                                                                                                                                                               | 位置                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| P1.1 | `IRReasoning` → `ReasoningIntent { mode, effort?, budget?, includeThoughts?, source }`；四个解码器按设计表填写，标注 `source`                                                                      | `gateway/src/ir.ts`、`request/decode.ts`     |
| P1.2 | 推理渲染：按上游协议与 `RuntimeModel.reasoning` 写入 `reasoning.effort` / `reasoning_effort` / `thinking` / `thinkingConfig`；effort ↔ budget 换算（比例法 + 固定表），预算夹取，`max_tokens` 补足 | `gateway/src/intent.ts`（新）、`upstream.ts` |
| P1.3 | 意图来源优先级：explicit > binding（暂用客户端模型配置里的 effort）> client-default；Claude Code 的 `budget_tokens` 标为 client-default                                                            | `request/decode.ts`、`server.ts`             |
| P1.4 | 请求备注：记录「请求的意图 / 发出的字段」                                                                                                                                                          | `server.ts` 的 notes                         |
| P1.5 | 测试：4×4 协议矩阵的推理渲染快照；换算的性质测试（单调、夹取、往返不漂移）                                                                                                                         | `gateway/tests/reasoningRender.test.ts`      |

**验收**：Claude Code → gpt（Responses）请求带 `reasoning.effort`；Codex → Claude（Messages）带 `thinking`；同协议透传请求体不变。

## P2 官方账号目录化（设计 §5.10，M0.7，随 v1.2.0 发布）

**目标**：一个账号一个配置目录；登录由 CLI 自己完成；Nomi 不读、不存凭据；多个账号并行；默认账号取代全局切换；保险箱凭据清除。

| #     | 任务                                                                                                                                                                                                                                               | 位置                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P2.1  | 实测项（设计 §5.10.8 待实测）：本机能做的先做——Claude 版本与 `.claude.json` 的 `oauthAccount` 结构（只看字段名）、Codex / Grok / Gemini 的状态命令能否给出邮箱；需要真实登录的列为人工项                                                           | 本文件「实测记录」                                                                                                                         |
| P2.2  | 账号模型：`AccountRecord { id, kind, label, home, identity, isDefault, createdAt }`，存 `userData/cli-accounts/accounts.json`（无凭据）；用户自己的 CLI 目录登记为默认账号                                                                         | `cli/accounts/types.ts`、`cli/accounts/AccountStore.ts`（新）                                                                              |
| P2.3  | 账号目录布局：按 CLI 的布局表创建账号目录（私有 / 软链共享 / 启动前同步 / 剔除路由与鉴权键）；路径规范化（绝对、NFC、无结尾斜杠、无软链）；Windows 用 junction；失败显式报告                                                                       | `cli/accounts/homeLayout.ts`（新）、`cli/accounts/layouts/{claude,codex,grok,gemini}.ts`                                                   |
| P2.4  | 启动前同步：Claude `.claude.json` 的 `mcpServers`、项目信任与已允许工具、主题、`hasCompletedOnboarding`；生成的 `settings.json` 剔除 `env` 里的路由与鉴权键并带上 Nomi 的 statusline；Codex `config.toml` 合并共享表并强制文件存储                 | `cli/accounts/homeSync.ts`（新）                                                                                                           |
| P2.5  | 登录与登出：在账号目录里运行 CLI 自己的命令（复用 `AccountLogin.ts` 的进度事件与输入转发，暂存目录改为账号目录）；删除账号：确认无活着的进程 → 目录内 `logout` → 删除目录                                                                          | `cli/accounts/AccountLogin.ts`、`cli/accounts/AccountService.ts`                                                                           |
| P2.6  | 身份读取（只读非凭据）：Claude 读 `.claude.json` 的 `oauthAccount`；其它 CLI 用状态命令；读不到显示「已登录」                                                                                                                                      | `cli/accounts/identity.ts`（新）                                                                                                           |
| P2.7  | 活进程检测：Claude `sessions/*.json`、`ide/*.lock`；其它 CLI 按进程表与锁文件                                                                                                                                                                      | `cli/accounts/liveProcesses.ts`（新）                                                                                                      |
| P2.8  | 编排：标签增加 `accountId`（官方来源下；空 = 默认账号）；启动时设置凭据目录变量、剔除 S3 列出的变量、非默认账号的 Claude 设 `CLAUDE_CODE_DISABLE_AGENT_VIEW=1`；改默认账号 / 标签换账号只重启用到它的官方标签；同一身份登录在两个目录时提示（S10） | `cli/CliHarnessService.ts`（`launchFor`、`childEnv`、`recycleBackend` → `recycleAccount`）                                                 |
| P2.9  | 额度按账号：被动来源按账号目录读；回退在账号目录里拉起官方 CLI；自动请求每账号 ≥ 30 分钟、仅卡片可见且 24 小时内用过；手动 60 秒节流                                                                                                               | `usage/quota.ts`、`usage/quotaCache.ts`、`usage/claudeSubscription.ts`、`codexRateLimits.ts`、`grokSubscription.ts`、`claudeStatusline.ts` |
| P2.10 | 历史：账号目录的会话目录软链回用户目录（S9）；历史服务按会话里的账号字段标注                                                                                                                                                                       | `cli/SessionHistoryService.ts`                                                                                                             |
| P2.11 | 迁移：保险箱里的账号转为「需要重新登录」记录；重新登录完成或放弃后清除保险箱凭据与备份；全局切换下线                                                                                                                                               | `cli/accounts/migrateVault.ts`（新）                                                                                                       |
| P2.12 | 终端启动命令：官方账号给出带凭据目录变量的命令                                                                                                                                                                                                     | `gateway/TerminalCommands.ts`                                                                                                              |
| P2.13 | IPC：`ai:cli-account:list / add / login-input / login-cancel / remove / rename / set-default / tab-set`（经 `guardedHandle`）；删除 `activate`、`import-current`                                                                                   | `cli/accounts/AccountService.ts`、preload                                                                                                  |
| P2.14 | 界面：官方账号区改为账号目录模型（默认账号标记、正在使用的标签数、需要重新登录）；标签端点按钮选账号；文案按 i18n 约定（en.json 同步）                                                                                                             | `ai-chat/src/components/ProvidersPage/OfficialAccounts.tsx`、端点按钮、`cliAccountClient.ts`、`ui/src/locales/en.json`                     |
| P2.15 | 测试：S5、S7（主进程不读凭据路径）、S10、S11；布局与同步；迁移；IPC；界面单测                                                                                                                                                                      | `electron/tests/unit/accounts/*`、`ai-chat` 单测                                                                                           |
| P2.16 | 文档：`docs/features` 中官方账号的用户文档、changeset（用户可见）                                                                                                                                                                                  | `docs/features/*`、`.changeset/*`                                                                                                          |

**验收**：设计 §9.5 人工检查清单之外的全部自动化测试通过；本机用 mock CLI 跑通「添加两个账号 → 两个标签并行 → 改默认账号 → 删除账号」。

## P3 诊断日志（设计 §8，M4）

| #    | 任务                                                                                                           | 位置                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| P3.1 | 接入已写的 `DiagnosticsService`、`cliTrace`；开发版必开、正式版开关；`spawnHarness` 挂记录；登录进程跳过（S8） | `electron/src/diagnostics/*`、`core/Application.ts`、`CliHarnessService` |
| P3.2 | Nomi 自身模型请求元数据日志（已在 `ProviderRouter` 加了钩子，接 `onCall`）                                     | `ai-runtime`                                                             |
| P3.3 | 网关追踪：诊断开关打开时启用；三层记录（上游原始 + 规范化差异 + 客户端差异）；traceId 响应头                   | `gateway/src/trace.ts`、`usage/GatewayRequestLog.ts`                     |
| P3.4 | 脱敏：`nomi-gw-` / `nomi-tab-` 前缀、查询参数名、设备码与授权码格式                                            | `gateway/src/trace.ts`、`diagnostics/cliTrace.ts`                        |
| P3.5 | 导出诊断包（zip，导出前再脱敏）；打开日志文件夹                                                                | `diagnostics/DiagnosticsService.ts`                                      |
| P3.6 | 界面：隐私设置里的开关（开发版只读显示）、打开文件夹、导出；用量页「调试模式」改为跳转                         | `SettingsView/PrivacySection.tsx`、`UsagePanel/GatewayRequests.tsx`      |
| P3.7 | 测试：开关、记录、脱敏、导出、S8                                                                               | 单测                                                                     |

## P4 网关：规范化 + 协议桥（设计 §6.1～§6.5、§6.11.1～§6.11.2，M1）

| #    | 任务                                                                                                                                                                            | 位置                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| P4.1 | 规范表：四种协议的事件全集、对象与事件必填字段、结束标记、顺序约束                                                                                                              | `gateway/src/spec/{responses,chat,messages,gemini}.ts`                |
| P4.2 | 规范化器（只做协议有效性）：白名单、必填字段、序号只补缺、完整条目展开、空输出兜底、结束检测、Chat / Gemini 字段归一；迁入 `responsesUsage.ts`、`TerminalWatch`、解码器兼容分支 | `gateway/src/canonical/*.ts`                                          |
| P4.3 | 协议桥：透传模式 / 转换模式；`RoutePlan.mode` 决定；合并 `createPassthrough`、`ChatStreamPatcher` 透传部分                                                                      | `gateway/src/bridge.ts`                                               |
| P4.4 | 结构修复统一到 `NormEvent`：正文工具调用、工具名还原、复读、finish_reason、确定性工具调用 id 与跨协议 id 映射                                                                   | `gateway/src/stream/fixer.ts` → `gateway/src/models/rules/response/*` |
| P4.5 | 非流式路径并入：JSON 展开成事件序列走同一流水线，再聚合                                                                                                                         | `gateway/src/server.ts`、`stream/json.ts`、`stream/aggregate.ts`      |
| P4.6 | 提交点改为第一个内容事件：元事件缓存（8 个 / 10 秒）、SSE 注释保活、提交前错误触发回退                                                                                          | `gateway/src/server.ts`                                               |
| P4.7 | 背压（`drain`）与取消；透传性能基准                                                                                                                                             | `gateway/src/server.ts`、`gateway/bench/`                             |
| P4.8 | 测试：故障注入（随机删字段、插未知事件、伪装保活、任意位置截断、重排）、附录 B 全部（含非流式）、提交点、背压                                                                   | `gateway/tests/canonical/*`                                           |

## P5 供应商规格（设计 §6.3，M2）

| #    | 任务                                                                                                 | 位置                                      |
| ---- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| P5.1 | `ProviderSpec` / `ProviderAdapterHooks` 与注册表；按预设与域名匹配                                   | `gateway/src/providers/index.ts`          |
| P5.2 | 迁入 `fixes.ts` 的供应商部分与预设 `quirks`；`generic`、`amux` 规格（保活特征、`response.metadata`） | `gateway/src/providers/{generic,amux}.ts` |
| P5.3 | 保活转心跳（`alive` 事件，按客户端规格输出）                                                         | `gateway/src/bridge.ts`、编码器           |
| P5.4 | 测试：请求方向与迁移前逐字节一致（快照）；Amux 回放用例                                              | `gateway/tests/providers/*`               |

## P6 客户端规格、进程令牌与绑定（设计 §5.5、§6.6、§6.7、§6.11.3～§6.11.5，M3）

| #    | 任务                                                                                                                                   | 位置                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| P6.1 | `ClientSpec`（严格程度、额外必填、事件子集、辅助模型、内置档位、会话键、心跳、遗留 UA）与 `ClientAdapter.conform`；五个 CLI 的规格数据 | `gateway/src/clients/*`                                                               |
| P6.2 | `route/resolve.ts` 的 `mapBuiltinModel`、`affinity.ts` 的会话键、`server.ts` 的 `legacyClient` 改读规格                                | `gateway/src/route/*`、`affinity.ts`、`server.ts`                                     |
| P6.3 | 进程令牌（`nomi-tab-` 前缀、进程代次）与 `TabBinding`（复用 `ClientModels`）；`binding:add / update / remove` 带应答；未知令牌短暂等待 | `gateway/src/route/binding.ts`、`electron/src/gateway/worker.ts`、`GatewayService.ts` |
| P6.4 | 模型解析顺序（显式 → 档位 → 辅助 → 绑定 → 未知名备注 → 默认）；辅助模型设置（`ClientModels.summary`）界面                              | `route/resolve.ts`、`ai-chat` 模型页                                                  |
| P6.5 | 换模型三种方式（gateway / inplace / restart）与占位模型名契约                                                                          | `CliHarnessService.ts`、`gateway/agents/index.ts`                                     |
| P6.6 | 状态码矩阵；count_tokens 走绑定；按 (供应商, Key) 的并发与每分钟请求数                                                                 | `gateway/src/server.ts`、`gateway/src/limits.ts`（新）                                |
| P6.7 | 测试：绑定竞态、标题请求走辅助模型、换模型三种方式、状态码、并发限流                                                                   | `gateway/tests/*`、`electron/tests/unit/*`                                            |

## P7 模型规格与路由计划（设计 §6.9，M3b-1～3）

| #    | 任务                                                                                                                                                                                                                                            | 位置                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P7.1 | （M3b-1）推理渲染器迁入模型适配器，作用在上游请求体上（同协议、跨协议共用）；参数归一（`max_completion_tokens`、采样参数、Messages 必填 `max_tokens`）；schema 清理器（gemini 双通道、kimi、deepseek、openai-strict）；推理回传与不透明推理去留 | `gateway/src/models/rules/request/*`                                                          |
| P7.2 | （M3b-2）模型目录：构建脚本从 models.dev 生成 `catalog.json`（带版本）；族默认；`EffectiveModel` 合并（族 → 目录 → 供应商 → 学习 → 用户）；学习带有效期                                                                                         | `gateway/src/models/{catalog.json,families/*,effective.ts}`、`scripts/build-model-catalog.ts` |
| P7.3 | （M3b-2）错误修正器：预算、档位、参数、协议、签名、自由工具；只重试一次、记结论                                                                                                                                                                 | `gateway/src/route/rectifiers.ts`（并入 `learn.ts`）                                          |
| P7.4 | （M3b-3）`RoutePlan`：过滤 + 规则排序；理由与损失；影子模式（与 `pickWire` 比对写日志）→ 切换                                                                                                                                                   | `gateway/src/route/plan.ts`                                                                   |
| P7.5 | 严格模式（默认关）开关：模型 / 供应商设置                                                                                                                                                                                                       | 网关配置、模型页                                                                              |
| P7.6 | 测试：§6.9.10 的典型路径矩阵；换算性质测试；目录快照；修正器回放                                                                                                                                                                                | `gateway/tests/models/*`                                                                      |

## P8 cli-sdk 与共享驱动（设计 §5.4，M5）

| #    | 任务                                                                                                                            | 位置                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| P8.1 | 新包 `@nomi-ai/cli-sdk`：插件契约类型（清单、能力接口、`SessionDriver`、`SessionEvent`、`PermissionAnswer`）、`defineCliPlugin` | `packages/cli-sdk/src/*`         |
| P8.2 | 驱动：`acp`（先做，Grok / Gemini 共用）、`stream-json`、`app-server`、`exec`；会话级事件流；权限多选项                          | `packages/cli-sdk/src/drivers/*` |
| P8.3 | `CliHarnessService` 拆成 `HarnessOrchestrator`（编排）+ 驱动；对外接口不变                                                      | `electron/src/cli/*`             |
| P8.4 | 启动注入通用实现：私有 HOME、叠加文件、账号目录（复用 P2.3）                                                                    | `packages/cli-sdk/src/launch/*`  |
| P8.5 | 测试：harness 现有测试全部通过；驱动单测（mock CLI）                                                                            | 现有 `tests/unit/cli/*` + 新增   |

## P9 内置插件（设计 §5.1～§5.9、§7，M6）

| #    | 任务                                                                                                                     | 位置                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| P9.1 | `@nomi-ai/cli-plugins` 包，按 `<cli>/{manifest,main,gateway,renderer}` 子路径；ESLint 入口边界规则                       | `packages/cli-plugins/*`、`eslint.config.*`             |
| P9.2 | 五个插件：启动、历史（含 `fork`、`provenance`、版本夹具）、模型、权限、进度、用量、账号（P2 的实现装进契约）、斜杠、终端 | `packages/cli-plugins/{claude,codex,grok,gemini,dsh}/*` |
| P9.3 | `CliPluginHost`：加载、清单校验、有效能力（清单 ∩ 版本开关 ∩ 握手）、启停、出错隔离；注册表快照 IPC `ai:cli:registry`    | `electron/src/cli/CliPluginHost.ts`                     |
| P9.4 | 统一 CLI 标识：`CliId` + 生成的 `BuiltinCliId`；替换 12 处类型联合；界面按能力位渲染                                     | 主进程、网关、界面                                      |
| P9.5 | 网关侧：插件 `gateway` 入口在 `electron/src/gateway/worker.ts` 组装进内核                                                | `electron/src/gateway/worker.ts`                        |
| P9.6 | CLI 升级策略：会话进行中检测到新版本 → 空闲重启续接；Windows 先排空                                                      | `cli/CliUpdateService.ts`                               |
| P9.7 | 测试：插件契约套件（每个插件跑一遍）                                                                                     | `packages/cli-sdk/src/testing/*`                        |

## P10 外部声明式插件与 lint（设计 §5.9、§7.3）

| #     | 任务                                                                                                        | 位置                    |
| ----- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| P10.1 | L1 声明式插件：JSON 清单 + ACP；「设置 → 编程助手 → 添加 CLI」；参数模板只做占位符替换并转义（POSIX / cmd） | `CliPluginHost`、设置页 |
| P10.2 | 核心目录 CLI 字面量 lint 规则（白名单之外报错）                                                             | `eslint` 自定义规则     |
| P10.3 | 测试：用一个未内置的 ACP CLI（mock）走通「添加 → 对话 → 历史」                                              | 单测 + `e2e-cli`        |

## P11 收尾

- 真实 CLI 一致性测试扩到五个 CLI、必填字段探测表进仓库（夜间 CI 配置）。
- 录制回放工具：诊断日志的上游原始流 → 脱敏夹具。
- 文档：`docs/features`、`docs/development/architecture.md` 更新；设计稿状态改为「已实现」并记录偏差。
- changeset：按包拆分用户可见的变化。

## 实测记录

**2026-10-24，本机（macOS）**

| 项                      | 结果                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude 版本             | 2.1.309（≥ 2.1.121，钥匙串按 `CLAUDE_CONFIG_DIR` 区分）                                                                                                                                                                                                                                                   |
| Claude 身份（不读凭据） | `claude auth status --json` 输出 `loggedIn`、`email`、`subscriptionType`、`orgId`、`orgName`、`authMethod`、`configDirectory`、`projectsDirectory`；随 `CLAUDE_CONFIG_DIR` 变化。采用它                                                                                                                   |
| Claude `.claude.json`   | `oauthAccount` 只有身份字段（`emailAddress`、`accountUuid`、`organizationUuid`、`subscriptionCreatedAt` 等），不含令牌；作为状态命令失败时的退路                                                                                                                                                          |
| Codex 身份              | `codex login status` 只给「Logged in using …」/「Not logged in」，没有邮箱；app-server 有 `account/read`（Codex 日志里可见），在账号目录里起 app-server 读取                                                                                                                                              |
| Grok                    | 有 `grok login` / `grok logout`；身份从 ACP 初始化后的状态读取（与现有 `grokAuth.ts` 一致）                                                                                                                                                                                                               |
| Gemini                  | 0.65.0；`.gemini/google_accounts.json` 的 `active` 是邮箱，不含凭据                                                                                                                                                                                                                                       |
| Claude 活进程           | 每个运行中的进程写 `<配置目录>/sessions/<pid>.json`（字段 `pid`、`cwd`、`kind`、`startedAt`、`status`…；同目录还有 `*.key`，不读）；不长期打开配置目录里的文件。按 pid 是否活着判断（2.1.309）                                                                                                            |
| Codex 活进程            | 运行中的进程一直打开账号目录顶层的 `state_*.sqlite`、`logs_*.sqlite-shm` 等；`lsof -t +d <目录>` 约 0.1 秒找到（0.163.0）；另有 `thread-writer-locks/*.lock`（空文件，不含 pid）                                                                                                                          |
| Grok / Gemini 活进程    | 未运行时 `lsof +d` 为空；运行中的打开文件未实测，按同一方法处理，查不了（Windows / 无 lsof）为 unknown，由删除确认兜底                                                                                                                                                                                    |
| Codex 身份              | app-server `account/read` → `{account: {type:"chatgpt", email, planType} \| {type:"apiKey"} \| … \| null, requiresOpenaiAuth}`，没有账号 id；`account/rateLimits/read` 的 `accountId` 才有（会请求 OpenAI，只读一次）。本机未登录 Codex，实测 `account/read` 返回 `account: null`，与 `login status` 一致 |
| 需要真实登录的人工项    | 在账号目录里登录后的文件 / 钥匙串形态；两个进程同目录并发刷新；Windows junction                                                                                                                                                                                                                           |

## 进度

| 阶段 | 状态   | 备注                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | 完成   | 基线：typecheck、lint 通过，测试只有已知的 `cliSearchPath` Windows 用例失败。`e2e-cli/`：假上游 + 进程内网关 + 本机 grok / codex / claude，`pnpm test:e2e-cli` 30 个场景通过；必填字段探测（`NOMI_E2E_PROBE=1`），快照 `e2e-cli/snapshots/grok-1.0.67.json`，网关的事件白名单与快照对照测试；来源隔离 S1～S5（electron）、S2（gateway）。**顺带修复**：上游中途断开时 Grok 默认的长重试会一直转圈，Nomi 生成的 Grok 配置加 `max_retries = 1`（实测从不结束 → 51 秒报错）                                                                                                                                                                                                                                                                                |
| P1   | 完成   | `gateway/src/intent.ts`（读意图、换算、按协议渲染），接在 `upstream.ts` 的跨协议分支；`learn.ts` 可学习去掉 `reasoning` / `thinking`；16 个新测试。偏差：没有改 IR 的 `IRReasoning`，意图直接从入口请求体读（与设计 C1「规则作用在请求体上」一致），P7 再并入模型适配器                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P2   | 完成   | 账号目录模型（`cli/accounts/homes.ts`、`identity.ts`、`AccountService.ts` 重写，`accounts.json` v2）；登录在账号目录里由 CLI 完成；凭据读写代码全部删除，S7 静态扫描测试；旧保险箱迁移为「需要重新登录」；编排层按标签选账号、改默认只重启跟随默认的标签；额度跟随默认账号，后台补取每工具 ≥ 30 分钟；会话归属（`session-accounts.json`）用于历史标注与按原账号续接；P2.7 删除前检查 Nomi 之外的活进程（`liveProcesses.ts`：Claude 按 `sessions/<pid>.json`，其它按 `lsof +d`）；Codex 身份经 app-server `account/read`（`codexAccount.ts`，邮箱 / 套餐，账号 id 只读一次并作为键别名，历史里的 creator_account_id 能对上）；用户文档与 changeset。**人工项**见「实测记录」（ChatGPT 登录下的 `account/read`、Grok / Gemini 运行时打开的文件、Windows） |
| P3   | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P4   | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P5   | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P6   | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P7   | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P8   | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P9   | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P10  | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P11  | 未开始 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
