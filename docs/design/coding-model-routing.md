# 模型与 Agents：统一供给池与按任务成本路由

状态：设计定稿（待实施）。

本文设计「模型与 Agents」的统一配置架构、按任务场景与复杂度分流成本的路由引擎，以及各日常入口的交互联动方案。目标是让同一个 agent（例如 Claude Code）同时保持「本机登录」「Nomi 官方多账号」「多家第三方供应商与本地模型」并存就绪，并允许高级任务走高质量订阅额度、低级或高频后台任务走低价第三方模型。

## 要解决的问题

结合现有实现，当前在模型与 Agents配置上存在四处结构性割裂：

1. **三类来源散落三处且数据层互斥清空**：
   - **本机登录**在 `packages/ai-chat/src/components/ProvidersPage/CliLauncherCard.tsx` 与 `apps/desktop-go/internal/core/cli/launcher.go` 中以整个 CLI 为粒度保存 `accountSource: 'local' | 'nomi'`。一旦切到 `'local'`，不但会隐藏 `OfficialAccounts` 列表，还会触发 `Orchestrator.LauncherChanged`（`apps/desktop-go/internal/core/cli/harness/orchestrator_idle.go`）刷掉该 CLI 全部官方标签的账号绑定。
   - **Nomi 托管官方账号与新会话默认**在 `ProvidersPage/OfficialAccounts.tsx` 与 `ProvidersPage/NewTabSourceRow.tsx`，选第三方时只能选到供应商粒度（`provider:<id>`），选择具体模型必须跨区跳到「模型与供应商」页。
   - **第三方模型分配**在 `ModelsPage/index.tsx`（`CliRow`）：给 CLI 选第三方主模型时会强行将 `newTabSource` 改为 `'thirdParty'`；而在 `services/cliSource.ts`（`newTabPatch`）把新会话默认切回官方账号时，又会清空 `models: { main: null }`。更进一步，**后端 `apps/desktop-go/internal/core/gwstore/service_write.go` 的 `normalizeAssignmentPatch` 也在做同样的双向强覆盖与清空**——设置 `models.main` 时强制改写 `newTabSource = "thirdParty"`，而设置 `newTabSource == "official"` 时调用 `withMainCleared()` 抹掉 `models.main`。前后端共同导致单个 CLI 无法同时保留「官方可用配置」与「第三方可用配置」。
2. **任务委派与模型脱节、绑死全局默认来源**：
   - `设置 → Nomi → 权限与委派`（`ProvidersPage/DelegateSettings.tsx`）中，左侧按任务类型（`coding / prd / review / research`）只能选 CLI，不能选模型；右侧 `cheapModel` 是手填 `provider/model` 的裸文本输入框。
   - 后端 `apps/desktop-go/internal/core/cli/delegate/service.go`（`overridesFor` / `preselectedModel`）校验第三方模型时直接读取 `Gateway.Defaults(cli)` 的全局 `source`：当某 CLI 日常默认走官方账号时，委派低成本子任务无法单次走 Nomi 网关调第三方模型（无法做到日常高级开发 `Claude Code + 官方 Opus`、低级调研 `Claude Code + DeepSeek`）。
3. **持续任务与定时巡检无法控本**：
   - `packages/ai-chat/src/components/Tasks/TaskForm.tsx` 与 `tasks.ExecutorSpec` 选择 `cli` 执行者时只能指定 CLI 名称，不能绑定成本档位或来源通道，高频定时巡检任务会消耗昂贵的官方订阅额度。
4. **后台辅助小请求配置深藏**：
   - 会话自动起标题、上下文压缩摘要、Claude Haiku 档与命令安全审核分散在各卡片的折叠区里，缺少一键统一绑定低价轻量模型的入口。

---

## 核心架构：「供给池」与「任务路由」解耦

将配置心智模型拆为纯正交的两层：**① 资源供给池（只管接通，并存不互斥）** → **② 成本档位预设与任务路由（按场景/复杂度取用）**。

```text
┌─ ① 资源供给池（只管接通，互不排斥） ──────────────────────────────────────────────┐
│  [本机环境登录]          [Nomi 托管官方账号]          [第三方供应商 & 本地模型]   │
│  (~/.claude 等默认目录)  (多账号 Pro / Max 独立目录)  (统一网关：DeepSeek/Ollama) │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ 任意组合，互不清空
                                       ▼
┌─ ② 成本档位预设（RunnerPreset = CLI × 来源 × 模型 × 思考深度） ───────────────────┐
│  🔥 高级攻坚 (high)          ⚖️ 日常均衡 (balanced)       🌱 轻量省钱 (low)        │
│  CC · 官方 · Opus 4.6        CC · 官方 · Sonnet 4.6       CC · DeepSeek · V3      │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ 自动升降档或按场景直接指定
                                       ▼
┌─ ③ 任务与高频入口路由 ────────────────────────────────────────────────────────────┐
│  • Nomi 委派（coding / review / research / prd）   • 定时与事件持续任务 (Tasks)   │
│  • 后台杂活降本（标题 / 摘要 / Haiku / 命令审核）  • 新建会话菜单 / 输入栏 / /agent│
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 1. 供给池的三类来源

| 来源 (`RunnerSource`)                 | 底层隔离方式                                                                                                                  | 适用 CLI（来自 `@nomi-ai/cli-catalog`）                                                                 |
| :------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| `local`（本机环境登录）               | 不注入 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME`，沿用用户终端默认登录目录与可选自定义启动前缀，并剥离网关残留环境变量 | 声明 `officialAccount: true` 且支持自定义启动器/本机凭据的 CLI                                          |
| `official`（Nomi 托管官方账号）       | 注入独立目录 `userData/accounts/homes/<cli>/<accountId>`，支持同 CLI 多账号并存（如 Max 账号与 Pro 账号各自独立隔离）         | `capabilities.officialAccount === true` 的内置 CLI（Claude Code、Codex、Grok、Kimi Code、MiniMax Code） |
| `thirdParty`（第三方网关 & 本地模型） | 注入标签私有目录 `<gateway>/agents/<cli>/<tabId>` 与一次性 `nomi-tab-` 令牌，经 Nomi 网关按 `tabBindings[tabId]` 动态路由     | 全部 `capabilities.thirdParty === true` 的 CLI（其中 Gemini CLI、dsh 仅有此来源）                       |

### 2. 统一执行规格与预设档位（`RunnerPreset`）

废弃此前只有 `default / cheap / local` 与 `cheapModel` 字符串的简陋 `AgentProfile`，统一升级为完整的执行规格：

```ts
export type RunnerSource = 'local' | 'official' | 'thirdParty';

export interface RunnerPreset {
  /** 内置固定三档 'high' | 'balanced' | 'low'；用户自定义档位 'preset-<id>' */
  id: string;
  builtin?: boolean;
  /** 自定义档位名称（内置三档由前端按 id 走 i18n 文案渲染） */
  label: string;
  cli: BuiltinCliId;
  source: RunnerSource;
  /** source === 'official' 时：null/空串表示跟随该 CLI 默认官方账号，否则指定具体账号 id */
  accountId?: string | null;
  /** official/local 时为 CLI 模型 id（空表示沿用该来源默认模型）；thirdParty 时为网关 'provider/model' ref */
  model?: string | null;
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
}
```

#### 开箱即用的智能推导（Smart Fallback）

用户首次升级或尚未显式保存档位时，前后端通过确定性纯函数，基于当前「已安装 CLI × 已登录官方账号 × 网关已启用模型」实时推导出默认 `high` / `balanced` / `low` 组合，避免空白配置：

- **`high`（高级攻坚）**：优先取已安装且有可用官方账号（或本机登录）的首个旗舰 CLI（如 `claude`）+ 强推理模型；若只有第三方高阶模型（如目录里标示旗舰推理的模型），则绑定该模型。
- **`balanced`（日常均衡）**：优先取常用主力 CLI + 均衡模型（如 `claude` 官方默认/Sonnet，或 `codex` 官方默认）；若仅有第三方网关模型，取主对话可用均衡模型。
- **`low`（轻量省钱）**：优先在已安装 CLI（支持 `thirdParty: true`）上绑定网关中已启用的高性价比轻量模型或本地模型（按单价从低到高优先，本地模型免费优先于低价云端模型）；若没有第三方供应商，则回退为已装 CLI 的默认轻量模型。
- **失效提示与回退**：当用户明确绑定的 CLI 被卸载、官方账号被移除或供应商被停用时，界面保留原绑定并在档位卡片上标出警示说明，运行委派时先按同来源可用默认回退或在确认前提示。

---

## 任务路由与智能复杂度升降档机制

### 1. 路由配置模型（`TaskRoutingSettings`）

```ts
export type RoutableTaskKind = 'coding' | 'review' | 'research' | 'prd' | 'scheduled';

export type RouteTarget =
  { mode: 'preset'; presetId: string } | { mode: 'custom'; spec: Omit<RunnerPreset, 'id' | 'label' | 'builtin'> };

export interface TaskRoutingSettings {
  /** 允许 Nomi 委派 agent 的总开关 */
  enabled: boolean;
  /** 按任务复杂度自动升降档（默认开启） */
  autoComplexity: boolean;
  /** 内置三档覆盖与用户自定义预设列表 */
  presets: RunnerPreset[];
  /** 五类场景路由表 */
  routes: Record<RoutableTaskKind, RouteTarget>;
  /** 全局后台辅助轻量模型（网关 'provider/model' ref；null 表示不覆盖） */
  helperModel?: string | null;
}
```

#### 默认场景基准

| 任务场景 (`RoutableTaskKind`)     | 默认绑定目标                           | 典型成本意图                                                             |
| :-------------------------------- | :------------------------------------- | :----------------------------------------------------------------------- |
| `coding`（代码开发与重构）        | `mode: 'preset', presetId: 'balanced'` | 日常功能开发用均衡档，复杂改动再升高级档                                 |
| `review`（代码审查）              | `mode: 'preset', presetId: 'high'`     | 高标准发现隐蔽缺陷；支持改为 `custom` 指定异构 CLI（如 CC 写、Codex 审） |
| `research`（代码库调研与检索）    | `mode: 'preset', presetId: 'low'`      | 大量读文件搜索极费 Token，优先走低价第三方模型                           |
| `prd`（需求文档 / 注释 / 单测）   | `mode: 'preset', presetId: 'low'`      | 文案、文档整理与样板单测无需消耗旗舰订阅额度                             |
| `scheduled`（定时与事件触发任务） | `mode: 'preset', presetId: 'low'`      | 防止高频定时巡检耗尽官方订阅时段额度                                     |

### 2. 零额外延迟的智能复杂度评估

为避免在派发任务前多发一次 LLM 请求造成延迟，复杂度评估直接随 Nomi 主对话模型调用 `delegate_to_cli` 的同一次推理完成：

1. **工具入参扩展**（`apps/desktop-go/internal/core/cli/delegate/schema.go`）：
   - 在 `delegateInputSchema` 中新增可选字段 `complexity`：`enum: ["simple", "standard", "complex"]`，描述为「仅按任务本身的工作量与风险评估：simple 改文案/小修/单点查询，standard 常规开发与单模块修改，complex 跨多文件重构/架构设计/疑难排查」。
   - 同时保留 `preset`（兼容旧 `profile`）、`model`、`cli`、`reasoning_effort` 字段。
2. **运行时解析优先级**（从高到低）：
   1. 用户在输入栏钉住或使用 `/agent` 显式指定的通道与模型（最高优先级，不自动降升档）；
   2. Nomi 工具调用中显式传入的 `model` / `preset` / `cli`（当用户消息明确点名时）；
   3. 场景路由 `routes[kind]`：
      - 若为 `mode: 'custom'`（用户专门绑死了特定 CLI + 模型）或指向用户自定义的 `preset-<id>`，直接采用该目标，不随 `complexity` 漂移；
      - 若指向内置三档且 `autoComplexity === true`，按以下确定性规则动态映射：
        - `coding`：`simple` → `low`，`standard` → `balanced`，`complex` → `high`；
        - `research` / `prd`：`simple` / `standard` → `low`，仅 `complex` 升至 `balanced`；
        - `review`：`simple` → `balanced`，`standard` / `complex` 保持 `routes.review`（通常为 `high`）。
      - 若 `autoComplexity === false`，严格使用 `routes[kind]` 对应的预设档位。

### 3. 全局后台辅助降本（`helperModel`）回退链

用户可在路由页一键设置全局 `helperModel`（例如 `deepseek/deepseek-chat`），统一剥离后台高频杂活的成本，同时保留细粒度覆盖优先权：

- **Nomi 后台请求**（会话自动摘要、素材库自动分类、命令风险审核，均经 `apps/desktop-go/internal/core/gwstore/service_runtime.go` 的 `nomiPick("summary")` / `NomiRoute("summary")`）：`clients.nomi.models.summary`（显式指定） > 全局 `helperModel` > `clients.nomi.models.main`。
- **主进程替 CLI 生成智能会话标题**（`gwstore/service_helper.go` 的 `HelperRoute`）：`summary` / `tiers.haiku` / `small` > 全局 `helperModel` > 当前标签或默认主模型。
- **第三方 agent 会话内辅助请求**（如 Claude Code `haiku` 档 / `small` / `summary`）涉及两条生效链路，需同步接入回退：
  1. 子进程启动环境变量注入：`gwstore/agents/agents.go`（`claudeTier`）写入 `ANTHROPIC_SMALL_FAST_MODEL` 与 `ANTHROPIC_DEFAULT_HAIKU_MODEL`；
  2. 网关槽位路由映射：`gateway/clients/clients.go` 的 `SlotModel`（由 `gwstore/service_cli.go:CliLaunchForTab` 与 `apps/desktop-go/harness_gateway.go:UpdateTab` 构造 `config.ClientModels` 写入标签绑定）。
     回退顺序：`clients[cli].models.tiers.haiku` / `small` / `summary`（显式指定） > 全局 `helperModel` > 当前标签主模型。

---

## 进程并发隔离与同会话切换的协议边界

### 1. 跨任务 / 多标签同时运行：原生并发隔离

每次新开 agent 标签、每次 Nomi 后台委派子任务、每次定时持续任务，都会生成独立的 `tabId` 并在子进程级别注入各自独立的配置与环境变量，**不修改用户任何全局 CLI 配置文件**：

- **`local` 来源标签**：不设置隔离 HOME 变量，执行可选自定义启动前缀，通过 `OfficialEnv` 清理遗留网关环境变量；
- **`official` 来源标签**：注入该账号的独立 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME`，多账号之间凭据与会话互不干扰；
- **`thirdParty` 来源标签**：创建独占 `<gateway>/agents/<cli>/<tabId>` 目录，网关 `CliLaunchForTab` 签发绑定该 `tabId` 的一次性 `nomi-tab-` 令牌。

因此，同一个 `Claude Code` 可以同时并发运行「本机登录标签」「官方账号 A 标签」「官方账号 B 子任务」「DeepSeek 调研子任务」「OpenRouter 定时任务」，互不冲突、无需重新登录。

#### macOS 系统沙箱与既有安全守卫约束

1. **系统沙箱天然兼容三源并发**：经核查，`apps/desktop-go/internal/core/cli/sandbox/sandbox.go` 的 `writableHome` / `writableHomeRegex` 已放行本机默认配置与缓存位置（如 `~/.claude`、`~/.claude.json` 等）；`apps/desktop-go/internal/core/cli/harness/sandbox.go` 的 `buildSandboxSpec` 已按标签分别放行 `cliHomeEnvs`（独立官方账号目录）与 `GatewayAgentDir`（第三方标签私有目录）。三类来源在同一机器上并发运行时，沙箱规则互不阻断、也无需关闭隔离。
2. **与三处 `nolocal_test.go` 安全不变量对齐**（`accounts/nolocal_test.go`、`harness/nolocal_test.go`、`gwstore/nolocal_test.go`）：
   - `AccountService` 仍严格**不恢复** `local-<kind>` 伪账号；
   - `source: "official"` 且没有 Nomi 托管官方账号时仍必须明确报 `no-account`，**绝不静默退回本机登录目录**；
   - `capabilities.officialAccount === false` 的 CLI（Gemini CLI、dsh）严禁选择 `'local'` 与 `'official'`（仅允许 `'thirdParty'`）；仅 `officialAccount === true` 的 CLI 允许显式指定 `source: 'local'`。

### 2. 同一标签中途切换配置的真实边界

对于**已经有历史消息的同一个标签**，中途切换模型或来源时遵循各家协议的客观边界：

| 同一标签内的切换方式                                                    | 底层处理机制                                                                                                                                                                                                         | 对话续接体验与代价                                                                                                               |
| :---------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| **`thirdParty ⇄ thirdParty`**（如 `DeepSeek` 切到 `OpenRouter/Claude`） | 网关调用 `UpdateTab` 内存热切换上游路由（若上下文窗口变化，则在空闲时重启子进程带 `--resume`）                                                                                                                       | **原生会话无缝续接**（_注：Codex 因 `app-server` 依赖启动期 `model_catalog_json`，仍走带前文重开_）                              |
| **同一官方账号内换模型**（如 `Opus` ⇄ `Sonnet`）                        | 空闲时重启子进程，传入原生 `--resume <cliSessionId> --model <new>`                                                                                                                                                   | **原生会话无缝续接**                                                                                                             |
| **同一 CLI 不同 Nomi 官方账号间切换**                                   | Claude Code 因各账号共享 `projects` 目录软链接，可直接 `--resume`；不共享历史的 CLI 清空 `cliSessionId` 携带上下文重开                                                                                               | Claude 原生续接；其余带上下文重开                                                                                                |
| **跨源切换（`official ⇄ thirdParty`、`local ⇄ official/thirdParty`）**  | Anthropic 等官方接口会严格校验历史 `thinking` 块的加密 `signature`，第三方推理块原样 `--resume` 会触发 400 错误。内核通过 `SetTabSource` 清空 `cliSessionId`，调用 `setCarried` 将前文对话打包为上下文摘要注入新会话 | **界面聊天记录不断流，但底层是新会话**（丢失 Prompt Cache，首轮需重新读一遍上下文摘要；切换前通过 `confirmDialog` 明确告知用户） |

---

## 界面与交互设计

### 1. 设置侧栏合并与深链接兼容

将原 `SettingsView/sections.ts` 中分散的 `models` 与 `coding` 合并为单一分区 **`ai`（「模型与 Agents」）**，并移除 `NomiSection`「权限」标签页中臃肿的 `DelegateSettings` 表单：

```text
侧栏分组更新（SETTINGS_NAV_GROUPS）：
  组 1：general（通用）、nomi（Nomi）
  组 2：ai（模型与 Agents）、usage（用量与分析）、computer（操作电脑）
  组 3：knowledge（知识与记忆）、ext（扩展与 MCP）、connections（应用连接）、privacy（隐私与权限）
  组 4：about（关于）[、debug（调试，仅开发版）]

「模型与 Agents」(ai) 顶部五标签（SECTION_TABS.ai）：
  [ routing · 任务与成本路由 ]   [ assistants · Agents 与账号 ]   [ providers · 三方模型 ]
  [ local · 本地模型 ]   [ monitor · 监视与会话 ]
```

- **向后兼容旧深链接**：
  - 打开旧 `'models'` 分区时自动映射至 `'ai'`（`tab === 'local'` 落在 `'local'` 标签，其余落在 `'providers'`）；
  - 打开旧 `'coding'` 分区（如输入栏 `/settings` 或「配置助手」按钮）时自动映射至 `'ai'` 的 `'assistants'` 标签。
- **`NomiSection` 精简**：原「权限与委派」里的 `DelegateSettings` 替换为一行只读概要 +「前往任务与成本路由」按钮，点击直达 `ai` 分区的 `routing` 标签。

### 2. Tab 1「任务与成本路由」布局与复合选择器

```text
┌─ 1. 成本与能力档位 ──────────────────────────────────────────────────────────┐
│  ┌─ 🔥 高级攻坚 ────────┐  ┌─ ⚖️ 日常均衡 ────────┐  ┌─ 🌱 轻量省钱 ────────┐  │
│  │ Claude Code          │  │ Claude Code          │  │ Claude Code          │  │
│  │ 官方 · work@…        │  │ 官方 · work@…        │  │ DeepSeek             │  │
│  │ Opus 4.6 · 高思考    │  │ Sonnet 4.6 · 中思考  │  │ deepseek-chat · 自动 │  │
│  │ [订阅额度]     [编辑]│  │ [订阅额度]     [编辑]│  │ [¥2/M · 极省]  [编辑]│  │
│  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘  │
│                                                           [ + 新增预设组合 ]   │
└────────────────────────────────────────────────────────────────────────────────┘

┌─ 2. 编程任务路由（Nomi 委派与持续任务） ───────────────────────────────────────┐
│  允许 Nomi 将子任务委派给 agent                                     [ 开启 ] │
│  按任务复杂度自动升降档（简单小改自动降轻量档，复杂重构升高级档）     [ 开启 ] │
│  ───────────────────────────────────────────────────────────────────────────── │
│  💻 代码开发与重构       [ ⚖️ 日常均衡 (CC · Sonnet 4.6)                 ▾ ]   │
│  🔍 代码审查             [ 🔥 高级攻坚 / 或单独指定如 Codex · 官方       ▾ ]   │
│  🧭 代码库调研与检索     [ 🌱 轻量省钱 (CC · deepseek-chat)              ▾ ]   │
│  📝 需求文档 / 注释单测  [ 🌱 轻量省钱 (CC · deepseek-chat)              ▾ ]   │
│  ⏰ 定时与事件触发任务   [ 🌱 轻量省钱 (新建任务时可单独调整)            ▾ ]   │
└────────────────────────────────────────────────────────────────────────────────┘

┌─ 3. Nomi 对话与后台辅助降本 ───────────────────────────────────────────────────┐
│  💬 Nomi 主对话模型      [ OpenRouter / claude-sonnet-4-6    ▾ ]  [更多用途 ▸] │
│  ⚡ 后台杂活统一轻量模型 [ DeepSeek / deepseek-chat          ▾ ]               │
│     统一接管：自动起标题、上下文压缩摘要、CLI 辅助档位 (Haiku)、命令审核       │
└────────────────────────────────────────────────────────────────────────────────┘
```

#### 核心新组件：`RunnerModelPicker`（两栏复合选择器）

点击任意档位卡片、或在任务路由下拉中选择「单独指定 CLI 与模型…」、或在新建定时任务中自定义执行者时，弹出统一的模态复合选择器：

```text
┌─ 选择执行方式与模型 ───────────────────────────────────────────────────────────┐
│ 左侧：选择 agent (CLI)   │ 右侧：选择来源通道与模型                          │
│                            │                                                   │
│ ● Claude Code       已安装 │ ── 本机与官方账号（订阅额度）──────────────────── │
│ ○ Codex             已安装 │ ○ 本机终端登录        沿用 ~/.claude 默认配置     │
│ ○ Gemini CLI        未安装 │ ● 官方账号 (work@…)   [ 默认 / Opus / Sonnet ▾ ]  │
│ ○ Grok              已安装 │ ○ 官方账号 (pers@…)   [ 默认 / Opus / Sonnet ▾ ]  │
│ ○ dsh               已安装 │                                                   │
│                            │ ── 第三方网关与本地模型 ───────────────────────── │
│                            │ ○ DeepSeek · deepseek-chat       [¥2/M · 极省]    │
│                            │ ○ DeepSeek · deepseek-reasoner   [¥4/M · 推理]    │
│                            │ ○ Ollama · qwen3-coder           [免费 · 本地]    │
├────────────────────────────┴───────────────────────────────────────────────────┤
│ 思考深度：[ 自动 ] [ 低 ] [ 中 ] [ 高 ]                      [ 取消 ] [ 确定 ] │
└────────────────────────────────────────────────────────────────────────────────┘
```

- `capabilities.officialAccount === false` 的 CLI（如 Gemini CLI、dsh）右侧自动置灰或折叠本机/官方账号组并说明「仅支持第三方模型」。
- 价格与成本标签直接复用 `packages/ai-chat/src/services/usageClient.ts` 中的 `pricing.builtin`（`UsageBuiltinPrice[]`）与模型长上下文价格，无定价时展示提供商与协议摘要，不杜撰价格。

### 3. Tab 2「Agents 与账号」、Tab 3「三方模型」与 Tab 4「本地模型」

- **Tab 2（`assistants`）**：
  - 保留顶部「助手 / 监视与会话」切换。
  - 每个 CLI 详情页内按从上到下顺序展示三块**并列不互斥**的内容：
    1. **版本与运行环境**：安装 / 检测 / 检查更新（`CliVersionCard`）；
    2. **接入通道状态（供给池）**：
       - **本机环境登录**：显示本机默认目录探测状态与折叠的自定义启动命令设置（`CliLauncherCard` 取消单选禁用下方账号的逻辑，仅管理自定义可执行命令与探测）；
       - **Nomi 托管官方账号**：始终完整展示多账号列表，支持登录多个官方账号并设置默认账号（不再因启用过本机登录而隐藏）；
       - **第三方网关通道**：显示已启用的网关供应商数，并提供快速跳转 Tab 3 管理供应商的按钮。
    3. **手动新建会话默认偏好**（`NewTabSourceRow`）：可选 `跟随档位` / `本机登录` / `官方账号` / `第三方模型`，修改默认偏好**只改变新标签默认指针，绝不清空已保存的 `clients[kind].models.main` 第三方模型配置**。
- **Tab 3（`providers`）**：
  - 第三方供应商卡片（添加、网页授权、拖拽排序、启停开关、高级参数与终端 `nomi-*` 命令），**移除原 `ModelsPage` 下半部的逐 CLI 模型分配网格**（收敛到 Tab 1 与 Tab 2）；
- **Tab 4（`local`）**：
  - 本机模型管理（复用意图完整的 `LocalPanel` 的 `models` 视图：llama.cpp 一键下载与 Ollama），与第三方供应商分成两个标签，避免单页过长。

### 4. 日常高频入口联动

1. **新建会话菜单（`NewChatMenu`）**：
   - 菜单顶部新增「快速按档位新建」分组，列出当前已配置且 CLI 已安装的档位（如 `🔥 高级攻坚 · Claude Code`、`🌱 轻量省钱 · Claude Code (DeepSeek)`），点一下即按完整 `cli + source + accountId + model + reasoningEffort` 创建标签；
   - 下半段保留原本按单个 CLI（或 Nomi）新建，沿用各 CLI 各自记住的新标签默认来源。
2. **输入栏「模型 · 思考深度」按钮（`ModelControls`）**：
   - Agents 标签底部点开模型弹层时，顶部增加一行**快捷切档药丸**（列出以当前 CLI 为主或可切过去的预设档位）；
   - 下方提供 `[本机] [官方账号] [第三方]` 分段切换，允许同一标签内直接切源（跨源且已有对话时，按前文协议边界弹出 `confirmDialog` 确认携带上下文重开）。
3. **`/agent` 斜杠命令与输入栏钉住胶囊**：
   - `/agent` 补全列表（`slash/agentComplete.ts`）置顶列出档位别名（如 `/agent high`、`/agent balanced`、`/agent low` 及自定义预设），其后列出各 CLI；
   - 输入框上方的钉住胶囊（`DelegateMenu` / `MessageInput`）与委派确认卡片清晰标出完整目标，例如 `Claude Code · DeepSeek (🌱 轻量省钱)`。
4. **定时 / 持续任务表单（`Tasks/TaskForm.tsx`）**：
   - 执行者选择「Agents」时，提供执行方式下拉：「跟随『定时任务』路由档位（推荐）」/「指定档位预设」/「单独指定 CLI 与模型（打开 `RunnerModelPicker`）」，不再默认裸选 CLI 消耗官方主力额度。
5. **官方额度 429 耗尽一键降级（`Messages.tsx` / `cliSlots.tsx` & `ErrorHint`）**：
   - 由于 `packages/ai-chat/src/components/ErrorHint/index.tsx` 在 `MessageInput/index.tsx` 中仅绑定 Nomi 主对话的 `chatError`，agent 标签的运行错误不经过 `ErrorHint`，而是在对话流消息卡片中渲染；
   - 因此，agent 标签侧在 `packages/ai-chat/src/components/Conversation/Messages.tsx` 的错误卡片操作区通过 `ConvSlots.errorActions`（由 `CliConversation.tsx` 与 `cliSlots.tsx` 的 `buildCliSlots` 注入切换回调）识别 `local` / `official` 标签收到的 429 / 订阅限额错误：若同一 CLI 在 `low` 档或网关中存在可用的第三方模型，渲染快捷按钮 **「切换本会话至 [🌱 轻量省钱档] 继续」**（点击后经跨源 `confirmDialog` 确认，调用 `setTabSource` 携带上下文切到第三方网关模型并重发/提示继续）；Nomi 主对话侧若遇到 429 限额则继续由 `ErrorHint` 承接。

### 5. 前端与多语言工程规范约束

- **控件高度与令牌**：设置行内的选择器与按钮统一 `--cd-control-h-sm`，输入栏工具行统一 `--cd-control-h-ms`；所有颜色、圆角、字号与间距只使用已定义的 `var(--cd-*)` 令牌，不在外部使用 `:global(.cd-*)` 覆盖共享组件（满足 `pnpm check:frontend`）。
- **无障碍与弹窗**：图标按钮一律不加原生 `title`，仅使用 `aria-label` 与可见文案 / `Tooltip`（满足 `nomi/no-icon-title`）；跨源切源等确认弹窗统一走 `confirmDialog`，不用系统弹窗。
- **不硬编码 CLI 名单**：前端列表与图标映射一律从 `@nomi-ai/cli-catalog` 的 `BUILTIN_CLI_ORDER` 与能力位读取，避免触发 `no-hardcoded-lists.test.ts` 与 `hardcoded_test.go`。
- **文案同步**：所有新增中英文词条写入 `packages/i18n/src/locales/{zh,en}` 并运行脚本同步至 `apps/desktop-go/internal/core/i18n/locales/{zh,en}`，确保产品语境用词通过 `pnpm check:i18n` 与 `pnpm check:character-leak`。

---

## 旧数据无损迁移方案

为确保升级后已有配置平滑过渡且测试夹具兼容，内核读取旧格式配置文件时执行以下幂等迁移：

1. **`cli-launcher.json` 迁移**：
   - 保留 `LauncherSettings` 的 `enabled` 与 `command` 用于自定义启动器前缀解析；
   - 若旧配置中某 CLI 的 `accountSource === 'local'` 且对应网关 `clients[kind].newTabSource` 仍为默认值 `'official'`（未曾设为 `'thirdParty'`），首次启动时将该 CLI 在网关里的 `newTabSource` 迁为 `'local'`，同时不再阻断该 CLI 使用 Nomi 官方账号或第三方网关。
2. **`delegate` 委派配置迁移（`apps/desktop-go/internal/core/cli/delegate/core.go`）**：
   - 读取旧字段 `{ enabled, defaults, defaultProfileId, profiles, cheapModel }` 时：
     - 若配置中尚未存在新版 `presets` / `routes`，自动生成迁移视图：
       - 若旧 `cheapModel` 非空（例如 `"deepseek/deepseek-chat"`），自动写入内置 `low` 档位的 `model`（若含 `/` 则 `source: 'thirdParty'`）；
       - 若旧 `defaults[kind]` 为某 CLI（如 `review: "codex"`），则将 `routes[kind]` 迁为 `{ mode: 'custom', spec: { cli: "codex", source: 当前该CLI默认来源, ... } }`；未指定的任务类型按默认场景基准映射；
     - 在兼容期内保持 `SanitizeDelegateSettings` 对旧版入参（仅传 `defaults / defaultProfileId / cheapModel`）的容错；**特别注意**：`apps/desktop-go/internal/core/cli/delegate/testdata/b7s2-delegate.json` 对 `SanitizeDelegateSettings` 返回的 `*util.Obj` 有逐字键序快照断言，因此持久化层对仅含旧字段的输入必须保持原有键序与字段集，仅当输入携带新版字段（`autoComplexity / presets / routes / helperModel`）时按固定键序追加落盘；而在 `Settings()` 视图返回与运行时路由解析中统一合并生成完整的 `TaskRoutingSettings`。
3. **`gateway/store.json` 迁移**：
   - `clients[kind].newTabSource` 扩展支持 `'local' | 'official' | 'thirdParty'`；
   - 读写 `clients[kind]` 时，`models.main`、`tiers`、`newTabAccountId` 各自独立持久化，移除任何切回官方/本机时清空 `models.main` 的清理逻辑。

---

## 分阶段落地改动清单

实施拆分为三个可独立验证的阶段：

### 阶段一：契约与 Go 内核多源解耦、档位路由引擎

- **契约与 Schema（TypeScript → Go 生成）**
  - `packages/contract/src/app/coding/schemas.ts`：扩展 `TabSource` 为 `z.enum(['local', 'official', 'thirdParty'])`；新增 `RunnerSource`、`RunnerPreset`、`RouteTarget`、`RoutableTaskKind`、`TaskRoutingSettings`、`TaskComplexity` schema；扩展 `DelegateSettings` 与 `DelegateSettingsView`；扩展 `harness.createTab` / `setTabSource` / `delegate.pin` / `delegate.dispatch` 入参支持可选 `source`、`accountId`、`presetId`。
  - `packages/contract/src/app/coding.ts`：同步更新 `harness.*` 与 `delegate.*` 过程契约定义。
  - `packages/contract/src/app/shell/schemas.ts`：扩展 `GatewaySetAssignmentInput` 的 `newTabSource` 支持 `'local'`，在网关全局选项或 `clients.nomi.models` 中暴露 `helperModel`。
  - `packages/contract/src/app/knowledge/taskSchemas.ts`：`TaskExecutorSpec` 的 `kind: 'cli'` 分支增加可选 `source`、`accountId`、`presetId`、`reasoningEffort`。
  - `apps/desktop-go/internal/contract/gen/`：运行 `pnpm --filter @nomi-ai/contract build && node scripts/go-contract/gen.mjs` 重新生成 Go 契约绑定。
- **Go 内核 CLI 启动与账号解耦**
  - `apps/desktop-go/internal/core/cli/launcher.go`：保留 `Enabled` / `Command` 启动前缀能力，解绑 `LauncherManagesLogin` 对整个 CLI 官方账号系统的全局互斥锁；新增 `HasLocalLogin(kind)` 探测本机默认目录凭据状态。
  - `apps/desktop-go/internal/core/cli/harness/orchestrator_launch.go`：新增标签级 `localLaunchFor(backend)`（不注入独立账号目录，剥离网关残留变量并应用自定义启动命令与模型参数），替换原先全局读取 `LauncherManagesLogin` 的判断。
  - `apps/desktop-go/internal/core/cli/harness/orchestrator_tabops.go` & `orchestrator_idle.go`：`CreateTab`、`SetTabSource` 支持 `'local'`（严格保持 `officialAccount: false` 的 CLI 拒绝 `'local'` 与 `'official'`，保持 `official` 无账号报 `no-account` 的安全守卫）；`SetTabSource` 在跨源切换且有历史消息时统一走 `setCarried` 带摘要重开；`LauncherChanged` 仅更新自定义命令行覆盖，不再批量抹除已有标签的 `accountId`。
- **Go 网关与辅助模型回退**
  - `apps/desktop-go/internal/core/gwstore/service_write.go`：解除 `normalizeAssignmentPatch` 对 `newTabSource` 与 `models.main` 的双向覆盖与 `withMainCleared()` 清空逻辑，支持 `'local' | 'official' | 'thirdParty'` 且保留独立配置的第三方模型。
  - `apps/desktop-go/internal/core/gwstore/service_cli.go` & `apps/desktop-go/harness_gateway.go`：`CliDefaults(kind)` 支持返回 `'local'`，且保留第三方 `models` 配置；`CliLaunchForTab` 与 `UpdateTab` 在写入标签绑定 `ClientModels` 时接入全局 `helperModel` 回退。
  - `apps/desktop-go/internal/core/gwstore/service_helper.go`、`service_runtime.go` & `agents/agents.go`：`HelperRoute`（CLI 标题）、`nomiPick("summary")` / `NomiRoute("summary")`（Nomi 摘要/分类/命令审核）以及 `claudeTier`（Claude `haiku` 环境变量注入）同步接入 `helperModel` 回退链。
- **Go 委派路由引擎、接线层与持续任务**
  - `apps/desktop-go/coding_wiring.go`：扩展 `delegate.Deps` 接线，除现有 `Gateway` 外补齐官方账号端口（`Accounts`，供账号列表与存在性校验）及已安装 `Bins` 读取端口，支撑 Smart Fallback 与多账号校验。
  - `apps/desktop-go/tasks_cli_wiring.go`：`taskCliHarness.CreateTab` 将 `tasks.CliCreateTab` 新增的 `Source`、`AccountID` 传入 `o.CreateTab(opts)`，确保后台/持续任务不再落回全局默认来源；同步更新任务侧会话复用键包含 `source` 与 `accountId`。
  - `apps/desktop-go/internal/core/cli/delegate/schema.go`：`delegateInputSchema` 新增可选 `complexity`（`simple | standard | complex`）与 `preset` 字段。
  - `apps/desktop-go/internal/core/cli/delegate/core.go` & `reuse.go`：实现 `RunnerPreset` / `TaskRoutingSettings` 清洗（兼容 `b7s2-delegate.json` 旧键序测试）、旧配置迁移、Smart Fallback 推导，以及 `ResolveRouteTarget` 解析逻辑；`ReuseKey` 增加 `source` 与 `accountId` 维度，防止同 CLI 不同来源/账号的委派会话错误复用。
  - `apps/desktop-go/internal/core/cli/delegate/service.go`：`overridesFor` 与 `delegateAsTask` 按解析出的完整 `RunnerSpec`（含 `cli / source / accountId / model / reasoningEffort`）独立校验并下发给后台标签，不再依赖 `Gateway.Defaults(cli).source`；`Pin` 支持绑定预设或完整规格。
  - `apps/desktop-go/internal/core/tasks/types.go` & `executor_cli.go`：`ExecutorSpec` 与 `CliCreateTab` 持久化并透传 `Source`、`AccountID`、`PresetID`、`ReasoningEffort`；若配置了 `PresetID`，在每次触发执行前实时读取最新档位规格。

### 阶段二：设置页「模型与 Agents」三标签合并与复合选择器

- **设置导航与分区重组**
  - `packages/ai-chat/src/components/SettingsView/sections.ts`、`index.tsx`、`sectionHelp.ts`：合并 `'models'` 与 `'coding'` 为 `'ai'`（标签 `routing | assistants | providers`），实现旧深链接映射与帮助栏更新。
  - 统一归一化全仓既有 `'models' | 'coding'` 跳转调用方：`packages/ai-chat/src/App.tsx`、`app/useAppPanels.tsx`、`app/useAppCommands.ts`、`app/useAppSlash.ts`、`components/EndpointInfo/index.tsx`、`components/SubagentPane/index.tsx`、`components/GettingStarted/index.tsx`（在 `openSettings` 保留对旧分区名的兼容归一化，并更新各内部跳转至 `'ai'` 对应标签）。
  - `packages/ai-chat/src/components/SettingsView/NomiSection.tsx`：移除原完整 `DelegateSettings` 表单，替换为精简开关状态摘要 + 跳转至 `ai/routing` 的按钮。
- **核心路由 UI 与复合选择器**
  - `packages/ai-chat/src/components/RunnerModelPicker/index.tsx` & `index.module.css`（新增）：两栏复合选择器弹窗（左选 CLI，右按「本机与官方账号」「第三方与本地模型」选来源与模型 + 成本/单价徽章 + 思考深度选择）。
  - `packages/ai-chat/src/components/AiSettingsSection/`（新增 `index.tsx`、`RoutingTab.tsx`、`PresetCards.tsx`、`TaskRouteTable.tsx`、`index.module.css`）：实现 Tab 1「任务与成本路由」（三档与自定义预设卡片、五类编程任务路由表、复杂度自动升降档开关、Nomi 对话与全局辅助模型配置）。
- **Agents 通道并存与供应商页面精简**
  - `packages/ai-chat/src/components/ProvidersPage/CliEndpointSection.tsx`、`CliLauncherCard.tsx`、`NewTabSourceRow.tsx`：取消 `accountSource === 'local'` 对 `OfficialAccounts` 的隐藏；重构为并列通道状态卡；`NewTabSourceRow` 支持直接选取预设/本机/官方账号/第三方模型。
  - `packages/ai-chat/src/components/ModelsPage/index.tsx`：移除下半部逐 CLI 分配网格（`CliRow` 逻辑迁入复合选择器与路由页），保留第三方供应商管理并内嵌 `LocalPanel` 本机模型视图。
  - `packages/ai-chat/src/services/cliSource.ts` & `services/delegateClient.ts`：彻底移除 `newTabPatch` 清空 `models.main` 的行为；封装 `RunnerPreset`、Smart Fallback 与 `TaskRoutingSettings` 前端工具函数及客户端方法。
- **多语言词典同步**
  - `packages/i18n/src/locales/{zh,en}/ui/*.json` 与 `apps/desktop-go/internal/core/i18n/locales/{zh,en}/ui/*.json`：补充新增界面与提示词条，运行 `node scripts/i18n/sync-go.mjs`（或同步脚本）保持一致。

### 阶段三：日常高频入口联动

- `packages/ai-chat/src/components/NewChatMenu/index.tsx` & 调用处（`Sidebar`、标签栏 `+`）：顶部渲染快捷档位新建分组，下半段保留单 CLI 新建。
- `packages/ai-chat/src/components/ModelControls/index.tsx` & `cliSource.tsx`：模型弹层顶部加入快捷切档药丸，完善标签内 `local / official / thirdParty` 同框切换与跨源重开确认。
- `packages/ai-chat/src/slash/agentComplete.ts`、`components/SlashPalette/index.tsx`、`components/MessageInput/DelegateMenu.tsx`、`components/MessageInput/index.tsx`：支持 `/agent <presetId>` 补全与钉住，并在输入框上方胶囊与委派卡片中展示完整通道及档位名。
- `packages/ai-chat/src/components/Tasks/TaskForm.tsx`：新建持续/定时任务选择 `cli` 执行者时，支持跟随 `scheduled` 路由档位、指定预设档位或打开 `RunnerModelPicker` 单独指定。
- `packages/ai-chat/src/components/Conversation/Messages.tsx`、`CliConversation.tsx`、`cliSlots.tsx` & `packages/ai-chat/src/components/ErrorHint/index.tsx`：在 CLI 标签消息视图通过 `ConvSlots.errorActions` 识别官方/本机 429 额度耗尽错误，提供一键切换本会话至可用 `low` 档（或第三方可用模型）继续的降级动作；Nomi 主对话侧的 429 恢复操作保留在 `ErrorHint` 中处理。

---

## 验证矩阵

每个阶段开发完成后，需按以下清单跑通全部自动化校验（均须无错误、无跳过通过）：

| 验证项                | 执行命令                                                                            | 覆盖范围                                                                      |
| :-------------------- | :---------------------------------------------------------------------------------- | :---------------------------------------------------------------------------- |
| 契约与 Go 生成一致性  | `pnpm --filter @nomi-ai/contract build && node scripts/go-contract/gen.mjs --check` | 前后端契约 schema、Go DTO 一致性                                              |
| Go 内核静态检查与单测 | `cd apps/desktop-go && go vet ./... && go test -tags private_mac_apis ./...`        | `cli`、`accounts`、`harness`、`delegate`、`gwstore`、`tasks` 与旧配置迁移单测 |
| 前端类型、规范与单测  | `pnpm typecheck && pnpm lint && pnpm test && pnpm check:frontend`                   | React 组件、服务逻辑、图标/弹窗/令牌/无硬编码 CLI 名单守卫                    |
| 多语言与角色名合规    | `pnpm check:i18n && pnpm check:character-leak && pnpm format:check`                 | 中英文翻译完整性、Go 词典同步、产品名规范、代码排版                           |
