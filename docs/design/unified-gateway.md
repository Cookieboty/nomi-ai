# 统一模型网关：一个第三方供应商，所有编程助手通用（设计稿）

> 状态：设计稿，待评审。调研日期 2026-10-21。
> 范围决定（2026-10-21）：
>
> - **只管第三方供应商**。官方账号（多账号登录、全局切换）保持 [官方账号](cli-official-accounts.md) 的现状；网关不读、不写、不转发任何官方凭据（§13）。
> - **Nomi 启动 CLI 用第三方时，不改动 CLI 本身的配置**：只作用于那一个进程（§12.0）。
> - **官方账号切换是全局的**：会改写 CLI 自己的凭据，终端里的 CLI 也跟着切。这是预期行为，保持现状（§13）。
> - **历史会话共享**：不管哪个官方账号创建、来自 Codex CLI / Desktop / IDE 还是 Nomi、走官方还是第三方，都能在 Nomi 的历史列表里看到并继续（§13.1）。
> - **第三方相关的交互可以全部推翻重做**；只保证用户数据（供应商、Key、已选模型）无损迁移。
>
> 相关：[编程助手接入](../features/coding-agent-harness.md)（§3.5 本地路由）、[官方账号](cli-official-accounts.md)、[用量卡片](usage-quota-cards.md)、[供应商](../features/providers.md)。

## 0. 一句话

用户只添加**一次**第三方供应商（选预设或填地址，再粘贴 Key），Nomi 自己的对话和 Claude Code、Codex、Gemini CLI、Grok、dsh 都能用它的任意模型。协议差异（Anthropic Messages / OpenAI Responses / OpenAI Chat Completions / Gemini generateContent）由本机网关**自动识别、自动转换**，用户不用选「API 格式」，也不用开「路由」。

**核心场景**：第三方选的是 GLM、DeepSeek、Kimi、Qwen、MiniMax 等模型，在 Claude Code 和 Codex 里也能直接使用，压缩、工具调用、推理、图片都正常工作（§12.7）。

第三方只在 Nomi 启动的会话里生效，**不改 CLI 的全局配置，不碰官方登录**：终端里的 CLI、官方多账号登录和切换，都和现在完全一样。

## 1. 现状与问题（代码事实）

| #   | 问题                                                | 代码位置                                                                                                                                                                                                                                                                               | 用户感受                                                                                              |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| P1  | 每个 CLI 一套第三方供应商                           | `CliProviderBridge`：`userData/cli-providers/{claude,codex,dsh,grok,gemini}/store.json`                                                                                                                                                                                                | 同一个 Key 要配 5 次，改一处漏一处                                                                    |
| P2  | 协议要用户自己选                                    | `cli/formats.ts` 的 `apiFormat`，下拉里写着「需开启路由」                                                                                                                                                                                                                              | 用户不知道中转站该选 Responses 还是 Chat；选错了只看到一个 4xx                                        |
| P3  | 路由按 CLI 类型分流，不按协议                       | `CliRouteService.detectKind()`：`/responses` 认作 codex，`/messages` 认作 claude；`resolveUpstream(kind)` 每种 CLI 只有一个上游                                                                                                                                                        | 入口协议和 CLI 被绑死，不能多上游，也不能按模型路由                                                   |
| P4  | 一个供应商只有一个地址                              | `RouteUpstream.baseUrl`                                                                                                                                                                                                                                                                | 国内厂商的 Anthropic 入口是另一个地址（`api.deepseek.com/anthropic` 等），表达不了                    |
| P5  | 转换枢纽是隐式的，且不完整                          | `routing/transforms.ts`：请求方向以 Anthropic Messages 为中间形态（4 个跨 OpenAI 方向由两段组合而成）；Gemini 只能作上游，不能作入口；非流式和流式是两套不统一的转换                                                                                                                   | 新增协议或字段时要在多处同步改，Gemini CLI 不能接入路由                                               |
| P6  | 中间事件缺字段                                      | `routing/stream/events.ts` 的 `NormEvent` 没有推理内容、签名、缓存 token                                                                                                                                                                                                               | 跨协议时思考过程丢失，缓存计费显示为 0                                                                |
| P7  | 失败直接透给 CLI                                    | 没有回退和重试                                                                                                                                                                                                                                                                         | 中转站 429 或 5xx 时整轮失败                                                                          |
| P8  | 路由跑在主进程                                      | `CliRouteService` 由 `Application` 直接持有                                                                                                                                                                                                                                            | 大流量流式转换占用主进程，可能让界面卡顿                                                              |
| P9  | Nomi 对话和 CLI 是两套供应商体系                    | `ai-runtime` 的 `ProviderStore`（`ai-providers.json`）与 `CliProviderBridge` 完全隔离；入口分散在设置页的 Nomi 标签、各 CLI 标签、对话框底部的供应商下拉 + 模型下拉、`CliProviderChip`、托盘菜单                                                                                       | 同一家厂商要在 Nomi 和每个 CLI 里各配一遍；用户分不清「供应商」「第三方供应商」「官方账号」三者的关系 |
| P10 | 启用第三方会改写 CLI 的全局配置，和官方登录互相影响 | `CliProviderBridge.activate()`：Claude 写 `~/.claude/settings.json` 的 `ANTHROPIC_API_KEY/BASE_URL/MODEL`；Codex 写 `config.toml`，**还往 `auth.json` 写 `OPENAI_API_KEY`**（官方账号切换改写的也是这个文件）；Grok 写 `~/.grok/config.toml`；官方账号切换流程因此要「自动停用第三方」 | 启用第三方后，终端里的 CLI 也不再用官方账号；两个功能互斥，来回切换容易出错                           |

已有可以复用的部分：本地监听与安全校验（回环地址限制、Host 头防 DNS 重绑定、本地令牌，见 `CliRouteService`）、流式解码器和编码器（`routing/stream/*`）、SSE 用量采集（`electron/src/usage/sniff.ts`）、配置备份与撤销（`configPatch.ts` 的 `unpatch*`）、Codex 自定义工具还原（`customToolNames`，定义在 `CliRouteService.ts`）、工具结果排序（`orderToolResultsFirst`，`transforms.ts` 内私有函数，迁移时导出）。

## 2. 目标与非目标

### 2.1 目标

1. **G1 一处配置**：第三方供应商只有一份列表（userData 里一个存储），Nomi 对话和所有 CLI 共用。`ai-providers.json` 和 `cli-providers/*` 都合并进来。
2. **G2 零协议配置**：添加时自动探测每种协议是否可用；运行时根据「入口协议 × 供应商可用协议 × 模型」自动选上游协议。用户界面上没有必填的「API 格式」字段。
3. **G3 任意组合**：任意入口协议 → 任意上游协议，流式、工具调用、推理、图片、用量都保真；做不到保真的地方有明确的降级规则（§9.4）。
4. **G4 按模型路由**：CLI 里选 `provider/model`。同一个 Claude Code 可以主模型用 A 家、后台小模型用 B 家。
5. **G5 不断流**：在向 CLI 发出第一个字节之前，遇到可重试的失败就自动换下一个 Key 或回退模型（§11）。
6. **G6 数据无损迁移**：`ai-providers.json` 和 5 份按 CLI 区分的供应商自动合并进来；旧版本写进 CLI 全局配置的第三方设置会被撤销，还原为用户原来的配置（§6.3）。**界面不做兼容**，旧页面和旧组件直接删除。
7. **G7 一个入口**：所有「用哪个第三方模型」的决定集中在设置里的一个「模型」页（§4）；对话框、托盘只保留一个统一的模型选择器。
8. **G8 不影响官方登录**：官方多账号登录、全局切换、终端里直接运行的 CLI，行为和现在完全一致。第三方只作用于 Nomi 启动的单个会话，同一个 CLI 可以一个标签用官方账号、另一个标签用第三方（§12.0、§13）。
9. **G9 历史会话共享**：所有账号、所有客户端（Codex CLI、Codex Desktop、IDE、Nomi）、官方和第三方的会话，都在 Nomi 的历史列表里可见、可继续；推理内容和原账号绑定时，用去掉推理内容的副本继续（§13.1）。

### 2.2 非目标（本设计不做）

- **不把官方订阅当上游**：不读取或转发 Claude、ChatGPT、Gemini、Grok 的登录凭据去服务别的 CLI。官方账号仍然由 [官方账号](cli-official-accounts.md) 直连负责（避免服务条款风险）。
- **不改写 CLI 的全局配置**：不让终端里直接运行的 `claude`、`codex` 等走第三方。想在终端里用第三方，用单独的启动命令（§12.6）。
- **不对外共享**：网关只监听回环地址，不做局域网共享、远程网关（与现有 `isLoopbackHost` 约束一致）。
- **不做意图路由、路由组策略引擎**（按额度、按用量、按意图选模型等）：只做顺序回退（§11）。路由组留到 P3 再评估。
- **不做联网搜索代理、生图、MCP 资料库**这类网关之外的功能。
- **不实现 Responses 的服务端状态**（`previous_response_id` + `store:true`）。Codex 默认 `store:false`，每次都发完整历史。碰到时返回明确的错误（§9.5）。

## 3. 设计原则

1. **能透传就透传**：入口协议和上游协议相同时原样转发字节，零转换损失；只有协议不同时才转换（§7.3、§9.2）。
2. **统一中间表示**：请求和流式事件都先转成一份统一格式，再转成目标协议，转换函数是 2N 个而不是 N² 个（§9）。
3. **协议属于供应商的地址和模型，不属于 CLI**：一个供应商每种协议各有一个地址；CLI 只决定入口协议（§6、§7.1）。
4. **探测优先于配置，运行时学习兜底**：添加时自动探测，用的过程中根据上游的报错修正，不让用户选协议（§7.4、§8）。
5. **只在首字节之前重试**：已经向 CLI 输出了内容就不再换线路，避免一个回复由两个模型拼成（§11.1）。
6. **加密内容只回原协议**：带签名或加密的推理内容按原字节保存，只发回产生它的那种协议（§9.3）。
7. **不碰官方登录**：第三方只通过启动参数、环境变量、Nomi 私有的叠加配置作用于单个 CLI 进程，不写 CLI 的全局配置和凭据（§12.0、§13）。

## 4. 用户体验（重做）

第三方相关的交互全部推翻；官方账号的界面不动。新的信息架构只有三个概念，界面上也只用这三个词：

| 概念             | 含义                                                                          | 以前分散在                                                                                          |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **第三方供应商** | 一个地址加一组 Key，提供一组模型                                              | 设置 → 编程助手 → Nomi 标签；各 CLI 标签里的第三方供应商列表                                        |
| **官方账号**     | 某个 CLI 自家的订阅登录（Claude、ChatGPT、Gemini、Grok）                      | **不在本方案范围内**：保持现有界面和能力（多账号登录、全局切换），本方案不改                        |
| **模型分配**     | 谁（Nomi 对话、工具调用、摘要、每个 CLI 的第三方会话）用哪个 `provider/model` | 对话框底部的供应商下拉 + 模型下拉、「任务路由」、各 CLI 标签的激活按钮、`CliProviderChip`、托盘菜单 |

### 4.1 设置 →「模型」页

取代现在设置里「编程助手」下各 CLI 标签中的第三方供应商列表，以及 Nomi 标签里的供应商配置。官方账号区留在原位置，不搬进来。

```
模型
┌─ 分配 ───────────────────────────────────────────────────────────────────┐
│ Nomi 对话      [deepseek/deepseek-v4-pro      ▾]                         │
│   工具调用     [跟随对话 ▾]     摘要 [deepseek/deepseek-v4-flash ▾]      │
│                                                                          │
│ 编程助手的第三方模型          新标签默认用                               │
│ Claude Code  主 [kimi/kimi-k3 ▾] 小 [deepseek/…-flash ▾] ▸  [官方账号 ▾] │
│ Codex        [deepseek/deepseek-v4-pro ▾]                    [第三方 ▾]   │
│ Gemini CLI   [relay-a/gemini-3-pro ▾]                        [官方账号 ▾] │
│ Grok         [未设置 ▾]                                      [官方账号 ▾] │
│ dsh          （未安装）                                                  │
└──────────────────────────────────────────────────────────────────────────┘
┌─ 第三方供应商 ─────────────────────────────────────────────── [+ 添加] ┐
│ ◆ DeepSeek     2 个 Key   Anthropic ✓ Chat ✓              12 个模型  ⋯ │
│ ◆ 某中转站     1 个 Key   Anthropic ✓ Responses ✓ Chat ✓  40 个模型  ⋯ │
└────────────────────────────────────────────────────────────────────────┘
终端启动命令  [ 关 ]   在终端里用 nomi-claude 等命令使用第三方模型（§12.6）
```

- **编程助手的第三方模型**：每个 CLI 选一个默认的第三方模型（统一的模型选择器，§4.4），在这个 CLI 的标签选择「第三方」时使用。Claude Code 行的「▸」展开 opus / sonnet / haiku / fable 各档和子代理模型；不展开时都跟随主模型和小模型。
- **新标签默认用**：`官方账号` / `第三方`。CLI 已经登录官方账号时默认选`官方账号`；没登录、但设置了第三方模型时默认选`第三方`。只影响新建的标签，**不改 CLI 的任何全局配置**。
- CLI 没安装时这一行变灰，显示「安装」按钮（复用 `CliVersionCard` 的安装逻辑）。
- 环境变量提供的供应商（`DEEPSEEK_API_KEY` 等）在第三方供应商列表里只读显示，带「环境变量」标签。

### 4.2 添加第三方供应商

一个三步的弹窗，**没有协议字段**：

1. **选来源**：搜索预设（厂商、中转平台、本地服务三类，沿用现有分类），或选「自定义地址」。
2. **填凭据**：粘贴 Key（可以一次贴多个，每行一个，自动成为主 Key 和备用 Key）。自定义地址的话，地址贴什么都行：根地址、`/v1`，或者完整的 `/v1/chat/completions`。
3. **检测并选模型**：自动并行探测（§8），2–5 秒出结果：
   ```
   ✓ Anthropic Messages   https://api.deepseek.com/anthropic
   ✓ OpenAI Chat          https://api.deepseek.com/v1
   ✗ OpenAI Responses     404
   发现 12 个模型  [全部启用] [只启用推荐的]
   ```
   所有协议都不可用时不能保存，逐条显示原因（Key 无效 / 地址 404 / 超时）。保存后如果还没有任何分配，提示「要让 Nomi 对话和已安装的编程助手都用它吗？」，一键填好分配区的模型。「新标签默认用」不会自动改，官方账号保持原样。

供应商详情（点「⋯」→ 编辑）：名称、Key 列表（拖动排序即回退顺序，每个 Key 显示最近一次错误）、模型列表（勾选启用、手动添加、刷新）、回退链。**高级**折叠区：手动改某个协议的地址、关闭某个协议、给模型指定协议、Key 限定协议、模型映射、自定义请求头和 User-Agent、清除运行时学到的状态（§7.4）。

### 4.3 对话窗口

- Nomi 会话：输入框旁的「供应商下拉 + 模型下拉」两个控件**合并成一个**模型选择器（§4.4），高度用 `--cd-control-h-ms`。
- CLI 标签：同一个位置显示这个标签的**来源**，点开是一个菜单：
  ```
  官方账号
    ● a@example.com（Claude Max）        ← 当前全局账号，切换账号进入现有的官方账号管理
  第三方
    kimi / kimi-k3
    deepseek / deepseek-v4-pro
    更多模型…
  ```
- 切换规则（原因见 §13 第 5 条）：
  - 空标签：直接切换。
  - 有消息时，第三方之间切换（换供应商或换模型）：原地切换，不重启进程，下一轮生效；只有模型参数（上下文、输出上限）差别大时才重启并续接（§13 第 5 条）。
  - 有消息时，官方 → 第三方：重启该标签的进程并续接原会话。
  - 有消息时，第三方 → 官方：提示「第三方的推理内容不能发给官方接口，将用去掉推理内容的副本（或带上下文的新会话）继续」，确认后按 §13.1 第 4 条处理；原会话保留。
- `CliProviderChip` 删除，由上面的来源菜单取代。
- 托盘菜单「AI Provider」改为「模型」，只管 Nomi 对话：列出最近使用的 5 个 `provider/model`，加一项「打开模型设置」。

### 4.4 统一的模型选择器

一个组件，用在分配区、对话窗口等所有选第三方模型的地方（新组件 `ModelPicker`，放在 `packages/ui`）：

```
[ 搜索模型…                       ]
最近使用
  deepseek / deepseek-v4-pro          Chat
  kimi / kimi-k3                      Anthropic
DeepSeek
  deepseek-v4-pro      推理 · 128K
  deepseek-v4-flash    128K
某中转站
  claude-opus-5-5      推理 · 视觉 · 1M
  …
```

- 按供应商分组，模型旁显示能力标签（推理、视觉、上下文长度，来源见 §12.7.2）。
- 给编程助手选模型时，`toolCalling: false` 的模型不出现；元数据是默认值（`metaSource: 'default'`）的模型标「参数未知」，提示用户补全上下文和输出上限。
- 右侧的协议标签只在「高级显示」打开时出现，默认不打扰用户。
- 键盘：上下键选择，回车确认，`Esc` 关闭；搜索支持 `provider/` 前缀过滤。

### 4.5 错误呈现

- 网关返回给 CLI 的错误，都按**入口协议**的格式写，消息里带上「Nomi 网关：」前缀和修复建议。例如「模型 `deepseek/deepseek-v5` 不存在，最接近的是 `deepseek/deepseek-v4-pro`」。
- Key 失效、某个协议被学到不可用时，供应商卡片上出现提示点，点开看原因。
- 用量面板「最近请求」里能看到每次请求的入口协议 → 上游协议、命中的供应商和 Key 名、是否发生了回退。

### 4.6 删除的界面

`ProvidersPage` 下的 `CliEndpointSection`、`CliProviderEditor`（`OfficialAccounts`、`CliVersionCard` 保留），以及 `ProviderPanel`（含任务路由）、`ProviderSwitcher`（Nomi 的供应商 + 模型双下拉）、`CliProviderChip`（CLI 的来源切换），设置页里按 CLI 分标签的结构。`ModelControls`（CLI 标签的「模型 · 思考深度」）保留，它的模型列表在第三方来源下改为读网关的模型。相关的 IPC 通道（`ai:cli-provider:*` 全部，`ai:providers:*` 中与供应商增删改和任务路由相关的）一并移除，由 `ai:gateway:*` 取代（§15）。

## 5. 架构

### 5.1 总览

```
 Claude Code ─┐ POST /v1/messages, /v1/messages/count_tokens
 Codex ───────┤ POST /v1/responses
 Grok / dsh ──┤ POST /v1/chat/completions | /v1/responses
 Gemini CLI ──┤ POST /v1beta/models/{m}:generateContent | :streamGenerateContent
 Nomi 对话 ───┤ 按模型的首选协议调用（§12.5），AI SDK 指向网关
              │ GET  /v1/models, /v1beta/models
              ▼
┌──────────── 网关（Electron utilityProcess，127.0.0.1:18721） ────────────┐
│ ingress  鉴权（客户端令牌）→ 按路径识别入口协议 → 解码成 IR             │
│ resolve  模型名 → 候选列表 [(provider, key, upstreamModel, wire)]       │
│ attempt  逐个候选：IR → 上游协议编码 → fetch（经上游地址校验，§15）     │
│          首字节前失败 → 冷却 → 下一个候选                               │
│ respond  同协议直接透传 | 上游流 → NormEvent → 入口协议编码             │
│ tap      用量 / 日志 / 修正（chat tidy、text calls、loop guard）        │
└──────────────────────────────────────────────────────────────────────────┘
        ▲ MessagePort：配置快照 + 已解密 Key（只在内存）、用量事件
┌──────── 主进程 ────────┐
│ GatewayService         │ 存储、探测、迁移、IPC、生成会话注入参数、进程守护
└────────────────────────┘
```

### 5.2 包与目录

新建 `packages/gateway`，**纯 Node**（不 import electron，和 `bundle-ig-base` 的约束一样），这样可以直接用 Vitest 做单元测试和端到端测试。

```
packages/gateway/src/
  index.ts              # createGateway(config) → { listen, update, close }
  server.ts             # http 监听、Host 校验、令牌校验、路径分发（从 CliRouteService 迁过来）
  ir/
    types.ts            # IR 的请求、消息片段、工具、事件、用量类型（§9.1）
    decode/{messages,responses,chat,gemini}.ts   # 入口请求 → IR
    encode/{messages,responses,chat,gemini}.ts   # IR → 上游请求
  stream/               # 从 electron/src/cli/routing/stream 迁过来，补字段
    decoders.ts encoders.ts events.ts sse.ts aggregate.ts json.ts
  route/
    resolve.ts          # 模型名 → 候选列表
    native.ts           # 选上游协议（§7.3）
    fallback.ts         # 回退、冷却、Key 轮换（§11.1）
    affinity.ts         # 缓存亲和（§11.2）
  fix/                  # 针对上游毛病的修正（§11.3）
    customTool.ts textCalls.ts chatTidy.ts betas.ts loopGuard.ts
  probe/detect.ts       # 协议探测（§8）
  models.ts             # /v1/models 各协议格式
  errors.ts             # 错误映射（§9.6）
  tokens.ts             # count_tokens 本地估算
packages/electron/src/gateway/
  GatewayService.ts     # 存储、迁移、IPC、utilityProcess 守护
  GatewayStore.ts       # userData/gateway/store.json（Key 用 safeStorage 加密）
  agents/{claude,codex,gemini,grok,dsh}.ts   # 每个 CLI 第三方会话的启动参数 / 环境变量 / 私有叠加配置（§12）
```

迁移完成后，`packages/electron/src/cli/routing/` 和 `CliProviderBridge` 里按 CLI 区分的存储逻辑删除。`configPatch.ts` 里的 `unpatch*` 只在迁移撤销旧配置时用一次（§6.3 第 7 步），「撤销旧配置」的代码（`unpatch*`）要保留到迁移入口和「重新导入旧配置」都移除为止，不按版本数删除，因为跨多个版本升级的用户首次启动新版本时仍然需要它；之后删除写全局配置的 `patch*` 函数。

### 5.3 进程模型

- 打包：`utilityProcess.fork` 需要磁盘上的入口文件（现有唯一先例是 `desktop/parse/runParse.ts` 的文档解析 worker）。`packages/gateway` 构建出单文件入口，放进 `asarUnpack` 或 `extraResources`，主进程按 `app.isPackaged` 解析路径；开发态直接指向构建产物。

- 网关跑在 Electron `utilityProcess` 里，由主进程 `GatewayService` 拉起并守护：崩溃后指数退避重启，3 次失败后在供应商页提示。
- 主进程解密 Key，通过 MessagePort 推送**配置快照**（供应商、路由、客户端令牌、已解密 Key）。网关进程不读写磁盘上的密钥。
- 网关通过 MessagePort 把用量事件、探测结果、学习到的协议可用性推回主进程。主进程负责持久化，并转给 `UsageService`。
- 配置改动时推送新快照，**进行中的请求继续用旧快照**，新请求用新快照。

## 6. 数据模型与存储

### 6.1 存储结构

文件：`userData/gateway/store.json`，用 `writePrivateFile` 原子写入。它取代 `userData/ai-providers.json` 和 `userData/cli-providers/*/store.json`。Key 的加密沿用 `ai-runtime` 的 `SecretCipher`（safeStorage 不可用时的降级与警告策略不变）。

```ts
type Wire = 'messages' | 'responses' | 'chat' | 'gemini';

interface GatewayStore {
  version: 1;
  providers: GatewayProvider[];
  clients: Record<ClientId, ClientConfig>;
  learned: Record<string /* providerId */, LearnedState>;
}

interface GatewayProvider {
  id: string; // URL 安全的短名，用在模型名前缀里：deepseek、relay-a
  aliases?: string[]; // 改名前的 id，旧的模型名仍然能找到它
  name: string;
  presetId?: string;
  enabled: boolean;
  urls: Partial<Record<Wire, string>>; // 每种协议的 base（规范化后，§8.1）
  keys: GatewayKey[];
  models: GatewayModel[];
  modelsSource: 'listed' | 'manual' | 'preset'; // 模型列表从哪来
  fallback?: string[]; // 本供应商失败时依次尝试的 'provider/model'
  headers?: Record<string, string>; // 少数中转站需要的额外请求头（高级）
  userAgent?: string;
  modelMap?: Array<{ from: string; to: string }>; // 对外名 → 上游真实名（沿用 ProviderStore 的模型映射）
  source: 'user' | 'env'; // env：来自环境变量，只读
  detected?: Partial<Record<Wire, ProbeResult>>; // §8，任一 Key 可用即 ok
  detectedByKey?: Record<string /* keyId */, Partial<Record<Wire, ProbeResult>>>;
  quirks?: {
    // 来自预设，用户也可在「高级」里改
    responsesTellsCache?: boolean; // §7.3 规则 4
    preferWire?: Wire; // 入口协议不可用时优先转成哪种协议，§12.7.4
    schema?: { drop?: string[]; flattenUnions?: boolean; noAdditionalProperties?: boolean }; // §12.7.3
    maxTools?: number;
    dropParams?: string[];
    userAgent?: string; // 转换协议时使用的 User-Agent
    reasoningPassback?: boolean; // 工具调用轮次要求回传 reasoning_content，§9.3
  };
  createdAt: number;
  updatedAt: number;
}

interface GatewayKey {
  id: string;
  name?: string; // 「主号」「备用」
  enc: string; // safeStorage 密文；不可用时按现有 secretCipher 策略处理
  wire?: Wire; // 有的中转站一个 Key 只对一种协议有效
  enabled: boolean;
}

interface GatewayModel {
  id: string; // 对外模型名（经 modelMap 映射后发给上游）
  enabled: boolean; // 是否出现在模型选择器里
  label?: string;
  wires?: Wire[]; // 手动限定这个模型能走的协议；不填表示不限制
  ctx?: number; // 上下文窗口（token），§12.7.1 注入给 CLI
  maxOutput?: number; // 输出上限（token），§12.7.3 压 max_tokens
  reasoning?: boolean; // 是否推理模型
  vision?: boolean; // 是否支持图片输入；false 时图片替换为文字说明
  toolCalling?: boolean; // 是否支持工具调用；false 时不出现在编程助手的模型选择器里
  metaSource?: 'user' | 'preset' | 'listed' | 'catalog' | 'default'; // §12.7.2
}

interface ProbeResult {
  ok: boolean;
  status?: number;
  at: number;
  model?: string; // 用哪个模型测的
  auth?: 'bearer' | 'x-api-key' | 'x-goog-api-key';
  error?: string;
}

/** 运行时学到的：某协议或某模型不可用，某模型不接受某参数 */
interface LearnedState {
  wireDown?: Partial<Record<Wire, { at: number; reason: string }>>;
  modelWire?: Record<string, Wire[]>; // 模型 → 实际可用的协议
  customToolsRefused?: string[]; // §11.3 custom tool 被拒的模型
  droppedParams?: Record<string, string[]>; // 模型 → 被拒、需要去掉的参数（如 service_tier）
}

type ClientId = 'nomi' | 'claude' | 'codex' | 'gemini' | 'grok' | 'dsh';

interface ClientConfig {
  newTabSource?: 'official' | 'thirdParty'; // 新标签默认来源（§4.1）；nomi 不用。不影响任何全局配置
  tokenEnc: string; // 这个客户端专用的本地令牌（§10.2），SecretCipher 加密存储；只通过启动环境变量交给 CLI 进程
  models: {
    // 全部写 'provider/model'
    main?: string;
    small?: string; // Claude：haiku 档和 SMALL_FAST；其他 CLI 不用
    tiers?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'fable', string>>;
    subagent?: string;
    tools?: string; // 仅 nomi：工具调用（原 ProviderStore 的 agent-tools 角色），空表示跟随 main
    summary?: string; // 仅 nomi：摘要（原 summary 角色）
  };
}

/**
 * 每个 CLI 标签的来源。加进现有的 HarnessTabMeta（cli/types.ts），随标签元信息一起存在
 * userData/harness/tabs.json 的 tabs[]（主标签在 session.json）；tabs/<id>.json 是消息文件，不放这里。
 * 现有的 modelScope / modelByScope（按来源分槽记忆模型）直接复用：scope 取值改为 'official' 或 'gateway'，
 * gateway 槽里存的是 provider/model。
 */
type TabSource = { kind: 'official' } | { kind: 'thirdParty'; model: string /* provider/model */ };
```

### 6.2 模型命名

- 对外统一叫 `provider/model`，例如 `deepseek/deepseek-v4-pro`。模型 id 本身可能也带 `/`（OpenRouter 的 `anthropic/claude-opus-5-5`），所以**按第一个 `/` 切分**。
- 解析顺序：
  1. 先按 `providers[].id` 精确匹配前缀，再按 `aliases` 匹配；
  2. 前缀匹配不到时当作裸模型名：先在**该客户端主模型所属供应商**里找（命名空间优先），找到就用；
  3. 再在所有已启用供应商里找，只有一家有才算命中；
  4. Claude Code 的内置名（`claude-*`）仍找不到时，按 §7.2 第 1 步的档位映射到配置的模型，不返回 404；
  5. 其余情况返回 404，列出最接近的候选（§11.3）。
- 裸模型名的兜底是为了兼容 CLI 内部写死的模型名（§12.2 的 `codex-auto-review` 等）。

### 6.3 迁移（G6）

首次启动新版本时，`GatewayService.migrate()` 执行一次，并在 `store.json` 里记下 `migratedFrom`：

1. 读出 `ai-providers.json` 和 5 份旧存储 `cli-providers/*/store.json`。
2. 按 **(规范化后的 base 主机名, Key 明文)** 去重，合并成一个供应商（`ai-providers.json` 里一个供应商有多个 Key，任一 Key 命中即视为同一个供应商，Key 取并集，保持原有顺序）：
   - 旧的 `apiFormat` 转成对应 `urls[wire]`（如 `openai_chat_completions` → `urls.chat`）；
   - 同一个 Key 在不同 CLI 里配了不同的协议地址，合并成同一个供应商的多个 `urls`；
   - 旧的 `model`、`models`、`fetchedModels` 放进 `models`；`modelMap`、`headers`、`userAgent`、`presetId` 保留；
   - `ai-providers.json` 的 `protocol` + `baseURL` + `fullUrl` 转成对应的 `urls[wire]`（`fullUrl` 时去掉协议路径后缀）。
3. 每个 CLI 当前激活的旧供应商 → `clients[kind].models.main = 'provider/model'`，`newTabSource = 'thirdParty'`；当前使用官方账号或没启用第三方的 CLI → `newTabSource = 'official'`（或不设）。
   Nomi 的「当前供应商 + 默认模型」→ `clients.nomi.models.main`；任务路由的 `agent-tools`、`summary` → `tools`、`summary`。
   **官方账号保险箱（`userData/cli-accounts/*`）不读不改。**
4. 合并完后后台跑一次探测（§8），补齐其他协议。
5. 旧文件改名为 `*.migrated`，**不删除**；新界面里不提供回到旧界面的入口，但迁移有问题时可以从这些文件重新迁移（设置 → 模型 → ⋯ →「重新导入旧配置」），两个版本之后清理。
6. 用量记录：`ProviderStore` 里按供应商记的用量按新的供应商 id 改写，接入 `UsageService`。
7. **撤销旧版本写进全局配置的第三方设置**（先备份到 `userData/gateway/backups/<时间戳>/`）：
   - Claude：只删 `~/.claude/settings.json` 的 `env` 里**值等于 Nomi 当初写入值**的 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`（与本地路由令牌、旧供应商的 Key、地址、模型比对）；用户自己改过的不动。
   - Codex：`unpatchCodexToml` 去掉 `[model_providers.nomi]` 和 `model_provider = "nomi"`；`auth.json` 里只删**等于 Nomi 写入值**的 `OPENAI_API_KEY` 字段，`tokens` 等官方登录字段一个字节都不动。
   - Grok / dsh：删掉带 `nomi managed` 标记的段落。
   - 撤销后提示一次：「终端里的 CLI 已恢复为你自己的配置和官方登录；第三方模型现在在 Nomi 的标签里使用，终端里可以用启动命令（§12.6）」。
   - 撤销失败（文件被占用、内容无法解析）时不强改，保留原样并在「模型」页提示，让用户手动处理或重试。
8. 端口：旧版本的 `routing.json` 里改过端口的，网关沿用那个端口；没改过的用默认 18721。撤销旧全局配置时（第 7 步）按旧的完整地址（含端口）比对。

## 7. 路由

### 7.1 入口协议识别

**只看路径，不看是哪个 CLI 发的**（解决 P3）：

| 路径                                                                | 入口协议                             |
| ------------------------------------------------------------------- | ------------------------------------ |
| `POST /v1/messages`、`/messages`                                    | `messages`                           |
| `POST /v1/messages/count_tokens`                                    | `messages`（只算 token，§10.1）      |
| `POST /v1/responses`、`/responses`                                  | `responses`                          |
| `POST /v1/chat/completions`、`/chat/completions`                    | `chat`                               |
| `POST /v1beta/models/{m}:generateContent`、`:streamGenerateContent` | `gemini`（模型名在路径里）           |
| `GET /v1/models`、`/v1beta/models`                                  | 按鉴权头的格式返回对应协议的模型列表 |

客户端身份从令牌得出（§10.2），**只用于**用量归属、读取该客户端的默认模型和场景映射，不参与协议判断。

### 7.2 解析候选

```
resolve(ingressWire, client, requestedModel) → Candidate[]

1. 模型名：requestedModel 为空、或是 CLI 写死的名字时，按客户端配置映射：
   - Claude Code：claude-*-haiku-* → models.small；opus / sonnet / fable 按 tiers；其他 → main
   - Codex：codex-auto-review 等内部名 → main（§12.2）
   - Nomi：按调用角色取 main / tools / summary（tools、summary 为空时用 main）
2. 按 §6.2 解析出 (provider, upstreamModel)
3. 展开候选：该供应商每个可用的 Key 各算一个 → 再接 provider.fallback 里的每一项（每项同样展开 Key）
4. 每个候选按 §7.3 选出 wire，没有可用 wire 的候选丢弃
5. 按 §11.2 的亲和结果调整顺序；处于冷却期的候选移到队尾
```

### 7.3 选上游协议（`native.ts`）

```ts
function pickWire(p: GatewayProvider, model: string, ingress: Wire, key: GatewayKey): Wire | null {
  const usable = wiresFor(p, model, key); // urls 里有 ∩ 探测为可用 ∩ 未被学到不可用 ∩ model.wires ∩ key.wire
  if (usable.length === 0) return null;
  const claudeOnMessages = isClaudeModel(model) && usable.includes('messages') && !manualWire(p, model);
  if (claudeOnMessages) return 'messages'; // 2. 保住缓存和 thinking（先于 1）
  if (usable.includes(ingress)) return ingress; // 1. 同协议：透传，零损失
  if (isOpenAIModel(model) && usable.includes('responses')) return 'responses'; // 3. 保住加密推理
  if (responsesTellsCache(p) && usable.includes('responses')) return 'responses'; // 4. 如魔搭
  const prefer = p.quirks?.preferWire;
  if (prefer && usable.includes(prefer)) return prefer; // 4.5 厂商指定的转换目标，§12.7.4
  for (const w of ['chat', 'responses', 'messages', 'gemini'] as const)
    // 5. 默认顺序
    if (usable.includes(w)) return w;
  return null;
}
```

规则 2 是为什么：中转站通常在 Chat 接口上丢掉 `cache_control`，Claude 模型走 Chat 会导致缓存命中率为 0、按全价计费。所以**即便入口是 Chat 或 Responses**，Claude 模型也优先走 Messages，规则 2 排在规则 1 前面；用户在「高级」里给这个模型手动指定了协议（`manualWire`）时不应用规则 2。

规则 5 为什么是 Chat 优先：中转站和国内厂商实现得最完整、最正确的是 Chat Completions；它们的 Responses 和 Anthropic 接口常常只实现了一部分。

`isClaudeModel` / `isOpenAIModel` 按去掉厂商前缀后的模型名判断（`claude*`；`gpt-*`、`codex*`、`o[0-9]*`）。

### 7.4 运行时学习

| 上游表现                                                            | 动作                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 404 / 405，或错误信息里有 `unsupported`、`not found` 且指向接口路径 | 本次请求换下一个 wire 重试一次；记一条 (provider, key, wire) 的**短期压制**（10 分钟）。同一 (provider, wire) 在 1 小时内对 ≥2 个模型连续 3 次出现，才升级为 `wireDown`（TTL 1 小时），升级前先跑一次 §8 的单协议探测确认 |
| 400 且指出模型不支持该接口                                          | 记 `learned.modelWire`；换 wire 重试一次                                                                                                                                                                                  |
| 400 且指出某个可选字段不支持（`service_tier`、`metadata` 等）       | 记 `droppedParams`；去掉该字段重试一次                                                                                                                                                                                    |
| custom tool 被拒                                                    | 见 §11.3                                                                                                                                                                                                                  |

上面这些重试都**只在首字节之前**进行，每个请求最多 2 次，并计入 §11.1 的总尝试次数。

区分「接口路径不存在」和「模型不存在」只能靠错误体启发式，中转站在这里最不规范，所以学习偏保守：短期压制只影响候选排序（排到后面，仍可用），不会把协议从 `usable` 里拿掉；只有升级成 `wireDown` 才拿掉。模型级的 `modelWire` 和协议级的 `wireDown` 阈值分开计算。学到的状态推回主进程持久化，并在供应商页的「高级」里显示，可以清除。

## 8. 协议探测

### 8.1 地址规范化

用户贴什么都能认：

1. 去掉首尾空白和末尾 `/`；
2. 依次去掉结尾的 `/chat/completions`、`/responses`、`/v1/messages`、`/messages`、`/models/{m}:generateContent` 等；
3. 按协议得到候选 base：
   - `chat` / `responses`：路径为空时补 `/v1`，否则原样（兼容 `/api/v1`、`/compatible-mode/v1`）；
   - `messages`：去掉结尾的 `/v1`（因为请求时会拼 `/v1/messages`）；
   - `gemini`：路径是 `/v1` 时换成 `/v1beta`，为空时补 `/v1beta`。
4. 预设里写明的地址优先于推导出来的地址。预设扩展成多地址（§8.4）。

### 8.2 探测流程

```
detect(provider):
  1. 拉模型列表（不花钱）：GET {chat base}/models，分别带 Bearer 和 x-api-key 各试一次
     → 得到模型列表 + 鉴权方式；失败也继续
  2. 每种协议挑一个测试模型：messages 优先 Claude 模型，responses 优先 OpenAI 模型，
     其余取列表第一个；没有列表就用预设的默认模型；都没有就要求用户填一个
  3. 4 种协议并行发最小请求（超时 15 秒）：
     messages : POST /v1/messages        {model, max_tokens:1, messages:[{role:user,content:"hi"}]}
     responses: POST /responses          {model, max_output_tokens:16, input:"hi"}
     chat     : POST /chat/completions   {model, max_tokens:1, messages:[{role:user,content:"hi"}]}
     gemini   : POST /models/{m}:generateContent  {contents:[{parts:[{text:"hi"}]}], generationConfig:{maxOutputTokens:1}}
  4. 判定：
     2xx                                     → ok
     401 / 403                               → 协议可能可用但 Key 无效：ok=false，error=鉴权失败（整体提示 Key 问题）
     400 且错误体是该协议的格式、错误针对参数 → ok（接口存在，只是参数不被接受）
     404 / 405 / 非 JSON / 连接失败           → ok=false
  5. 结果写入 provider.detected，ok 的协议写入 urls
  6. 多个 Key 时：第 3 步对每个启用的 Key 各测一次（并发上限 4），结果按 Key 记录；
     某协议只要有一个 Key 可用就算可用，并把可用情况写进该 Key 的 `wire` 限定
```

- `max_output_tokens` 用 16 是因为部分 Responses 实现拒绝小于 16 的值。
- 探测请求和转发一样经过上游地址校验（§15），不带用户的提示词，**会消耗极少量 token**；界面上「检测」按钮旁写明这一点。
- 触发时机：添加或编辑供应商时（用户点击）；迁移完成后（后台）；`wireDown` 升级前（确认），以及 `wireDown` 过期后下一次用到时（后台）。

### 8.3 鉴权头

| wire        | 默认鉴权                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `messages`  | `x-api-key` + `anthropic-version: 2023-06-01`；探测发现只认 Bearer 时改用 `Authorization: Bearer` |
| `responses` | `Authorization: Bearer`                                                                           |
| `chat`      | `Authorization: Bearer`；探测发现只认 `x-api-key` 时改用它                                        |
| `gemini`    | `x-goog-api-key`                                                                                  |

### 8.4 预设扩展

`ai-runtime/src/providers/presets.ts` 的预设从单地址（`protocol` + `baseURL`）扩展为每种协议一个地址（`urls`），并新增 `defaultModels` 和 `quirks`，网关和 Nomi 自己的对话共用。首批要写明 Anthropic 入口的厂商：DeepSeek（`/anthropic`）、智谱（`/api/anthropic`）、Kimi（`/anthropic`）、MiniMax、Qwen（百炼），以及 Anthropic、OpenAI、Gemini、xAI、OpenRouter 官方。每个地址在 M2 实测一次再写入，并在预设旁注明查证日期。

核心场景（§12.7）要求首批厂商的预设还要写全：每个模型的 `ctx` / `maxOutput` / `reasoning` / `vision` / `toolCalling`，以及厂商的 `quirks`（`preferWire`、`schema`、`maxTools`、`dropParams`、`reasoningPassback`）。Coding Plan 类套餐单独作为预设（§12.7.5）。

## 9. 转换内核

### 9.1 IR 类型

```ts
type PartKind = 'text' | 'image' | 'file' | 'tool_call' | 'tool_result' | 'thinking';

interface IRPart {
  kind: PartKind;
  text?: string; // text / thinking / tool_result 的文本
  mediaType?: string;
  data?: string;
  url?: string; // image / file（base64 或 URL）
  id?: string;
  name?: string;
  args?: string; // tool_call（args 为 JSON 字符串）
  callId?: string;
  isError?: boolean;
  images?: IRPart[]; // tool_result
  signature?: string; // Anthropic thinking 签名；Gemini thoughtSignature
  sealed?: { by: 'messages' | 'responses'; raw: unknown }; // 加密推理的原文（§9.3）
  cache?: { ttl?: '5m' | '1h' }; // Anthropic cache_control
  custom?: boolean; // 来自 Codex custom（freeform）工具的调用
}

interface IRMessage {
  role: 'user' | 'assistant';
  parts: IRPart[];
}

interface IRTool {
  name: string;
  description?: string;
  schema?: unknown;
  strict?: boolean;
  kind: 'function' | 'custom'; // custom：Codex freeform，转成参数为 {input:string} 的函数
  namespace?: string; // Responses 的命名空间工具
  cache?: { ttl?: '5m' | '1h' };
}

interface IRRequest {
  model: string;
  system: IRPart[]; // 保留分段，便于保留每段的 cache_control
  messages: IRMessage[];
  tools: IRTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  parallelToolCalls?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  reasoning?: {
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    budget?: number;
    off?: boolean;
    visible?: boolean;
  };
  format?: { type: 'json_object' } | { type: 'json_schema'; name: string; schema: unknown; strict?: boolean };
  serviceTier?: string;
  cacheKey?: string; // Responses 的 prompt_cache_key
  /** 只能原样带给同一种协议的字段 */
  passthrough: {
    messages?: { metadata?: unknown; betas?: string[] };
    responses?: { include?: string[]; client_metadata?: unknown; text?: unknown; store?: boolean };
    chat?: Record<string, unknown>;
    gemini?: Record<string, unknown>;
  };
}
```

流式事件在现有 `NormEvent` 的基础上补齐：

```ts
type NormEvent =
  | { type: 'start'; id?: string; model?: string; usage?: StreamUsage }
  | { type: 'text'; text: string }
  | { type: 'think_start'; id?: string } // 新的一段推理开始
  | { type: 'think'; text: string }
  | { type: 'think_sig'; signature: string } // Anthropic signature_delta
  | { type: 'sealed'; by: 'messages' | 'responses'; raw: unknown } // redacted_thinking / 带 encrypted_content 的 reasoning item
  | { type: 'text_sig'; signature: string } // Gemini 正文的 thoughtSignature
  | { type: 'tool_start'; key: string; id: string; name: string; custom?: boolean }
  | { type: 'tool_args'; key: string; delta: string }
  | { type: 'tool_end'; key: string }
  | { type: 'usage'; usage: StreamUsage }
  | { type: 'finish'; reason: StopReason; usage?: StreamUsage }
  | { type: 'error'; message: string; errorType?: string; status?: number; retryAfterMs?: number }
  | { type: 'alive' }; // 心跳，编码器按协议输出（SSE 注释或 ping）

interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal';
```

### 9.2 解码与编码

- 4 个入口解码器（请求 → IR）、4 个上游编码器（IR → 请求）、4 个流式解码器（上游 SSE → NormEvent）、4 个流式编码器（NormEvent → 入口 SSE）、4 个非流式聚合器。
- **同协议路径绝不经过类型化 IR**：类型化 IR 会静默丢掉协议的新字段（新 beta、新参数），这是保真度的最大风险。
  - 请求：JSON 浅解析，只做外科式改写：替换 `model`（去掉 `provider/` 前缀、应用 `modelMap`）、去掉被拒字段（§7.4）、过滤 beta（§11.3），其余所有字段（包括不认识的）原样保留后再序列化。Gemini 的模型名在路径里，改路径不改请求体。
  - 响应：非流式原样返回，只改回 `model` 字段；流式按 SSE 事件逐个转发，只为用量采集解析，只在需要时修改事件（Chat 流修正、回写模型名）。
  - 因为模型名几乎总要改，所以不存在真正的「字节级透传」；这里的承诺是「不丢字段」。
- 现有 `transforms.ts` 的转换逻辑按方向拆进各个解码器和编码器，原有测试用例改写成「解码 → 编码」的往返用例保留下来。

### 9.3 推理内容（思考过程）

| 情况                                                                              | 处理                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic 上游返回 `thinking` + `signature`，入口也是 Messages                    | 原样透传                                                                                                                                                                                                                                                                                           |
| Anthropic `redacted_thinking`、Responses 带 `encrypted_content` 的 reasoning item | 存为 `sealed`。加密内容是**上游厂商加密、和厂商（甚至 Key）绑定**的，不只是和协议绑定。**默认剥离**：只有会话归属表（§11.4）明确记录上一轮是「同一供应商、同一 Key、同一协议」时才原样发回；没有记录、记录不同、取不到会话键时，一律在转发前剥掉（同协议路径上也要剥，作为 §9.2 的外科式改写之一） |
| 历史消息里的 thinking 发给非 Anthropic 上游，或发给另一个 Anthropic 兼容供应商    | 去掉签名（不同厂商的签名不能互认；只有两边都是 Anthropic 官方地址时才保留）；Chat 上游如果是 DeepSeek / Kimi 这类要求回传 `reasoning_content` 的（`quirks.reasoningPassback`），作为 `reasoning_content` 放回 assistant 消息，否则丢弃                                                             |
| Chat 上游的 `reasoning_content` / `reasoning` 增量                                | 转成 `think` 事件；Messages 入口输出为不带签名的 thinking 块，Responses 入口输出为 reasoning summary                                                                                                                                                                                               |
| 正文里的 `<think>…</think>`                                                       | 默认原样保留；供应商「高级」里可以打开「拆分 think 标签」，把它转成 `think` 事件                                                                                                                                                                                                                   |
| 推理强度                                                                          | `reasoning.effort` ↔ Anthropic `thinking.budget_tokens`（按 `max_tokens` 的比例换算）↔ Gemini `thinkingConfig` ↔ Chat `reasoning_effort`                                                                                                                                                           |

**不依赖上游的容忍**：有的上游（比如会自己清理请求的聚合网关）收到别家的签名或加密推理也不报错，但官方接口和直连厂商会直接 400。网关的剥离规则按「最严格的上游」设计，不因为某个供应商实测能容忍就放宽；预设里也不提供「保留签名」之类的开关。

**被拒后的兜底**：请求里带着保留下来的签名或加密推理，上游仍然返回 400 时，如果错误文本命中推理校验的特征（`signature`、`thinking`、`encrypted_content`、`reasoning`、`decrypt`、`verif` 等关键词，不区分大小写），或者是带有这些内容时才出现的未知 400，就剥掉全部签名和加密推理**重试一次**，并在会话归属表里把这个会话标为「不再保留」。重试仍失败就把原始错误返回给客户端。特征清单写在 `packages/gateway` 的一处常量里，随实测补充。

### 9.4 字段映射与降级规则

| 字段                                                      | 规则                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| system                                                    | Messages 的 system 数组 ↔ Responses 的 `instructions` + developer 消息 ↔ Chat 的 system 消息 ↔ Gemini 的 `systemInstruction`          |
| `cache_control`                                           | 只有 Messages 上游保留；其他上游丢弃（OpenAI 和 Gemini 是自动缓存）                                                                   |
| 图片                                                      | base64 / URL 互转；上游只接受 base64 时，网关**不主动下载** URL 图片，按原样传并依赖上游报错（避免 SSRF）                             |
| PDF / 文件                                                | 只在 Messages 和 Gemini 之间互转；其他协议转成一行 `[attachment: application/pdf]` 文本并记一条警告日志                               |
| custom（freeform）工具                                    | 非 Responses 上游：转成参数为 `{input:string}` 的函数；回程还原为 `custom_tool_call`（复用 `customToolNames`）                        |
| 服务端工具（`web_search`、`web_fetch`、`code_execution`） | 非原生上游不支持：从工具列表里去掉，并记一条日志；不做代理搜索                                                                        |
| `tool_choice`                                             | `any` ↔ `required`；指定工具名互转；Gemini 用 `functionCallingConfig`                                                                 |
| 结构化输出                                                | Responses `text.format` ↔ Chat `response_format` ↔ Gemini `responseSchema`；Messages 上游没有原生支持时，把 schema 写进 system 提示词 |
| `max_tokens`                                              | Messages 必填：入口没给时用模型元数据里的上限，没有元数据时用 8192（沿用 `DEFAULT_MAX_TOKENS`）                                       |
| 停止原因                                                  | `end_turn` ↔ `stop` ↔ `completed` ↔ `STOP`；`tool_use` ↔ `tool_calls`；`max_tokens` ↔ `length` ↔ `incomplete:max_output_tokens`       |
| 用量                                                      | 统一换算：Messages 的 `input_tokens` 不含缓存，OpenAI 的 `prompt_tokens` 包含缓存；IR 里 `inputTokens` 一律表示**不含缓存读写**的部分 |
| 连续的 assistant 消息                                     | 合并为一轮（Claude Code 会把并行工具调用拆成两条 assistant 消息发来）                                                                 |
| tool_result 顺序                                          | 转 Chat 时把 tool 消息放在同一轮 user 文本之前（沿用 `orderToolResultsFirst`）                                                        |

### 9.5 明确不支持的输入

以下情况网关按入口协议返回 400，消息里说明原因，不静默降级：

- Responses 入口带 `previous_response_id`，而选中的上游不是 Responses；
- Responses 入口 `store: true` 并依赖服务端会话，上游不是 Responses；
- 音频输入输出、实时（realtime）接口；
- `n > 1`。

### 9.6 错误映射

上游错误统一归类，再按**入口协议**编码，确保各 CLI 自带的重试逻辑能正确识别：

| 类别              | Messages 入口                                                 | Responses / Chat 入口                          | Gemini 入口              |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------- | ------------------------ |
| 限流（429）       | 429 `rate_limit_error`                                        | 429 `rate_limit_exceeded`                      | 429 `RESOURCE_EXHAUSTED` |
| 过载（503 / 529） | 529 `overloaded_error`                                        | 503 `server_error`                             | 503 `UNAVAILABLE`        |
| 鉴权（401 / 403） | 401 `authentication_error`                                    | 401 `invalid_api_key`                          | 401 `UNAUTHENTICATED`    |
| 请求错误（400）   | 400 `invalid_request_error`，带上游原文                       | 400 `invalid_request_error`，带上游原文        | 400 `INVALID_ARGUMENT`   |
| 上下文超长        | 400，消息里带 `prompt is too long`，触发 Claude Code 自动压缩 | 400 `context_length_exceeded`，触发 Codex 压缩 | 400                      |

- 上游给了 `Retry-After` 时原样转发。
- 已经开始输出后才出错：按入口协议发流式错误事件（Messages 的 `event: error`、Responses 的 `response.failed`、Chat 的 `data: {"error":…}`），然后结束流。

## 10. 网关入口

### 10.1 接口

| 接口                             | 说明                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /health`                    | 不需要鉴权，返回 `{ok, service:"nomi-gateway", version}`                                                       |
| `POST /v1/messages`              | 带上 `anthropic-beta`、`anthropic-version`；上游是 Messages 时转发 beta（经 §11.3 过滤）                       |
| `POST /v1/messages/count_tokens` | 上游是 Messages 时转发，失败（404 / 405）就记下该供应商不支持并改用本地计算；本地计算见 §10.3                  |
| `POST /v1/responses`             | 见 §9.5 的限制                                                                                                 |
| `POST /v1/chat/completions`      | 流式时如果上游支持，自动补 `stream_options.include_usage: true`                                                |
| `POST /v1beta/models/{m}:*`      | Gemini 入口                                                                                                    |
| `GET /v1/models`                 | Bearer 鉴权返回 OpenAI 格式；`x-api-key` 返回 Anthropic 格式；只列出已启用供应商的模型，id 为 `provider/model` |
| `GET /v1beta/models`             | Gemini 格式的模型列表                                                                                          |

### 10.2 鉴权与客户端令牌

- 每个客户端一个独立令牌，格式 `nomi-gw-<client>-<随机 32 字节 base64url>`，存在 `store.json` 里（用 safeStorage 加密），只通过启动环境变量交给对应的 CLI 进程（终端启动命令从 0600 的令牌文件读取，§12.6），**不写进 CLI 的配置文件，不经 IPC 返回给渲染进程**（与现有 `authToken()` 的约束一致）。
- 令牌决定客户端身份：用于用量归属，以及读取该客户端的默认模型和场景映射。
- 令牌从 `x-api-key`、`Authorization: Bearer`、`x-goog-api-key`、`?key=` 中任意一个读取，用 `timingSafeEqual` 比较。
- 「重置令牌」按钮：生成新令牌；运行中的第三方会话在下一轮重启时换用新令牌。
- **旧版本的共享令牌**（`userData/cli-providers/routing.token`，`nomi-route-…`）：只可能出现在旧版本写进全局配置、迁移还没撤销成功的终端 CLI 里（§6.3 第 7 步）。处理：
  - 撤销成功之前继续接受旧令牌，客户端身份按入口路径推断（`messages` → claude；`responses` / `chat` 再看 User-Agent 区分 codex、grok、dsh，区分不了就记为「旧版配置 · 未知客户端」，不做场景映射），这样 §7.2 的场景映射照常生效；用量记到「旧版配置」名下。
  - 撤销全部成功后，删除旧令牌文件，旧令牌立即失效。
  - 撤销失败的，在「模型」页持续提示，直到用户处理；不无限期静默保留。

### 10.3 count_tokens 的本地计算

Claude Code 用 `count_tokens` 的结果决定什么时候压缩上下文，纯字符估算偏差太大会导致压缩过早或过晚。本地计算按以下顺序：

1. **用真实用量校准**：网关每次转发真实请求都能拿到上游返回的 `input_tokens`（含缓存部分）。按 (会话键, 供应商, 模型) 记住「上一次请求的消息前缀哈希 → 实测输入 token」，内存 LRU。实测值来自上游厂商的分词器，换了供应商或模型就不能复用。
2. count_tokens 请求到来时，找到与它共享最长消息前缀的已记录请求：结果 = 实测值 + 估算(新增部分)。新增部分通常只是最近一两轮，估算误差被压到很小。
3. 找不到可校准的记录时（会话第一轮），退回纯估算：字符估算函数从 `ai-runtime/src/providers/estimate.ts` 搬到 `packages/gateway/src/tokens.ts`，`ai-runtime` 改为从网关包导入，不跨包深引用 `src`。
4. 返回值统一向上取整 5%，宁可稍早压缩，也不要超过上下文上限。

## 11. 可靠性

### 11.1 回退与冷却

- 候选列表见 §7.2。每个请求最多尝试 **4 次**（含 §7.4 的换协议重试）。首字节之前的总耗时上限 60 秒，到点就停止尝试并返回错误，即使次数没用完。
- 可以换下一个候选的情况：连接失败、首字节前超时（默认 30 秒，可配置）、429、5xx、529、401 / 403（换 Key）、§7.4 的学习类错误。
- 不换的情况：其余 400（请求本身有问题，换了也一样）、**已经向客户端发出了任何字节**。
- 冷却的维度是 **(供应商, Key, wire)**：同一个 Key 在 Chat 端点可用、Anthropic 端点 401 的情况很常见，不能互相牵连；429 也一样，不同协议端点的额度常常分开计算。
  - 429、5xx、超时：冷却 60 秒，期间排到候选队尾；上游给了 `Retry-After` 时，冷却 `min(Retry-After, 10 分钟)`。
  - 401 / 403：冷却 10 分钟，在供应商页该 Key 的该协议上标红。同一个 Key 的所有协议都 401 时，才整体标红。
- **流式空闲超时**：首字节之后，上游连续 180 秒没有任何事件（心跳也算事件），按入口协议发流式错误事件并结束，避免 CLI 永久卡住。推理模型可能长时间没有正文，但通常有推理增量或心跳，所以阈值取得比较宽；可配置。
- 所有候选都失败时，返回最后一个候选的错误（按 §9.6 映射），消息里列出每个候选的失败原因。

### 11.2 缓存亲和（简化版）

- 会话键：优先用 `prompt_cache_key`（Codex）、`metadata.user_id`（Claude Code）；没有时，用「system + 第一条 user 消息」的哈希。
- 记录「会话键 → 上次成功的 (供应商, Key)」，内存 LRU（1000 条，30 分钟过期）。
- 下一次请求时，该 (供应商, Key, wire) 不在冷却期就排到第一位。
- 「system + 第一条 user 消息」的哈希在同版本 CLI 的不同会话之间可能碰撞，后果只是排序偏好不准，可以接受。

### 11.3 针对上游毛病的修正

| 修正                 | 触发条件与做法                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| custom tool 被拒     | Responses 上游返回 `Unsupported custom tool` 一类 400：同协议改为转换模式（custom 转成函数），记入 `customToolsRefused`，之后这个模型都从转换模式开始                                                    |
| 正文里写出的工具调用 | 请求带了工具、上游是 Chat：输出中出现 `<tool_call>`、`<｜DSML｜invoke`、GLM 的 `<arg_key>` 标记时，从该处开始缓存正文；结束时能解析成「已提供的工具名 + 合法参数」的块转成真正的工具调用，其余按正文输出 |
| Chat 流修正          | 去掉空的 `reasoning_content`；`finish_reason: ""` 改为 `null`；去掉重复的空工具名；去掉空的 `tool_calls: []`（同协议透传时也要做）                                                                       |
| beta 过滤            | 上游是 Bedrock 等已知会因未知 beta 拒绝请求的，去掉不认识的 `anthropic-beta`；学到被拒的 beta 记下来，之后不再发                                                                                         |
| 复读检测             | 最近 N 个句子里不同的句子不超过 K 个（推理和正文分别统计），判定为复读，按入口协议发错误事件并结束                                                                                                       |
| 模型不存在           | 404，列出编辑距离最近的 3 个模型名和命名规则                                                                                                                                                             |
| 可选字段被拒         | 见 §7.4 `droppedParams`                                                                                                                                                                                  |

每个修正都有独立开关（默认开），在用量面板的请求详情里标出这次请求用了哪些修正。

### 11.4 会话归属表

一张持久化的小表，记录「会话 → 上一次服务它的 (供应商, Key, 模型)」，文件 `userData/gateway/sessions.json`（0600），最多 5000 条、30 天未用自动淘汰。和 §11.2 的内存亲和表不同，它跨重启保留，用途有三个：

- **剥离加密推理**（§9.3）：只有记录显示上一轮是同一供应商、同一 Key、同一协议时才保留历史里的加密推理和签名，其余情况一律剥掉；被拒重试过的会话标为「不再保留」；
- **历史列表显示供应商名**（§13.1 第 2 条）：rollout 里只记得到 `nomi_gateway`，具体供应商从这里查；
- **count_tokens 校准**（§10.3）：校准数据按 (供应商, 模型) 分开。

会话键：Codex 用 `prompt_cache_key`（它就是 thread id，请求头 `session-id` 也是同一个值），Claude Code 用请求头 `x-claude-code-session-id`（`metadata.user_id` 是一段 JSON 字符串，里面的 `session_id` 是同一个值，作为兜底），以上均为 M0 实测；Gemini 和其他客户端用 Nomi 启动会话时注入的标签 id（经请求头 `x-nomi-tab`，只在 Nomi 启动的进程里有）。都取不到时不记录。

## 12. 接入各客户端

### 12.0 总原则：第三方只作用于单个会话

- **第三方只在 Nomi 启动的 CLI 会话里生效**：用启动参数、环境变量，或 Nomi 私有目录里的叠加配置文件，注入网关地址、令牌和模型，**只作用于这一个进程**。
- **不写 CLI 的全局配置，不碰任何凭据**：`~/.claude/settings.json`、`~/.claude.json`、钥匙串、`~/.codex/config.toml`、`~/.codex/auth.json`、`~/.gemini/*`、`~/.grok/*`、`$DSH_HOME/*` 一律不写。终端里直接运行的 CLI 永远是用户自己的配置和官方登录。
- 唯一例外是用户主动开启的「终端启动命令」（§12.6）。它是 Nomi 私有目录里的独立脚本，也不改这些文件。
- 环境变量统一经过 `buildCliEnv` 生成：第三方会话注入网关变量；官方会话**剥掉** Nomi 可能残留的网关变量（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 等于网关地址或令牌时），保证官方会话不会误走网关。用户自己在 shell 里导出的变量照旧继承（现有行为）。
- **第三方会话还要剔除会抢鉴权的继承变量**：spawn 的环境以 `process.env` 为基础（`cliChildEnv` → `buildCliEnv`），用户 shell 里导出的变量都会继承。第三方会话除了覆盖网关变量，还要**显式删除**：Claude 的 `ANTHROPIC_API_KEY`（M0 实测：和 `ANTHROPIC_AUTH_TOKEN` 同时存在时，两个头**都会发**，`Authorization: Bearer <令牌>` 加 `x-api-key: <继承的 Key>`，用户的真实 Key 会被送到网关）、`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` 一类切换后端的变量；Codex 的 `OPENAI_API_KEY`、`OPENAI_BASE_URL`；Gemini 的 `GOOGLE_API_KEY`、`GOOGLE_GENAI_USE_VERTEXAI`、`GOOGLE_CLOUD_PROJECT`。清单集中写在各自的 `agents/<cli>.ts`。
- 每个启动参数和环境变量的键集中写在 `packages/electron/src/gateway/agents/<cli>.ts` 一处。所有「待实测」的项目在 **M0 前置验证**（§18）里统一用当前版本实测，结果和查证版本记在本节；M0 的结论决定各 CLI 采用主方案还是退路。实测结果汇总在 §12.8。

### 12.1 Claude Code

第三方会话启动时注入以下环境变量：

| 环境变量                                            | 值                                                        |
| --------------------------------------------------- | --------------------------------------------------------- |
| `ANTHROPIC_BASE_URL`                                | `http://127.0.0.1:18721`（不带 `/v1`）                    |
| `ANTHROPIC_AUTH_TOKEN`                              | `claude` 客户端令牌                                       |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` | `clients.claude.models.tiers`，没设的档位用 `main`        |
| `ANTHROPIC_DEFAULT_*_MODEL_NAME` / `_DESCRIPTION`   | 模型显示名 / 「Nomi 网关 · 供应商名」，显示在 `/model` 里 |
| `ANTHROPIC_SMALL_FAST_MODEL`                        | `small`，没设时用 `main`                                  |
| `CLAUDE_CODE_SUBAGENT_MODEL`                        | `subagent`（设置了才注入）                                |

另外加启动参数 `--model <标签选的模型>`，以及 §12.7.1 的模型参数（上下文窗口、输出上限、推理预算、能力声明）。

- **`--model` 必须显式传**（M0 实测）：不传时 Claude Code 默认解析成 `sonnet[1m]`，把模型当成 1M 上下文，并在请求头 `anthropic-beta` 里带上 `context-1m-…`。显式传档位别名（`--model sonnet`）或模型名后，就按 `ANTHROPIC_DEFAULT_SONNET_MODEL` 映射，不带 `[1m]`。
- 网关**从不转发**客户端发来的 `x-api-key`，即使继承变量没剔干净也不会把用户的真实 Key 送到上游。

- 用 `ANTHROPIC_AUTH_TOKEN`，**不用** `ANTHROPIC_API_KEY`：后者会触发「是否使用这个 API Key」的确认，并把确认结果写进 `~/.claude.json`。
- 环境变量里的令牌优先于钥匙串里的 OAuth 登录，所以第三方会话不会读取、刷新或改写官方凭据。同一时间另一个标签里的官方会话照常使用官方账号。
- 不设 `CLAUDE_CONFIG_DIR`：会话历史、`CLAUDE.md`、技能、MCP 配置和官方会话共用，用户感觉不到差别。

### 12.2 Codex

第三方会话启动时用 `-c` 覆盖配置（现有权限模式、模型选择已经这样做，见 `permissionMode.ts`、`modelCatalog.ts`）：

```
codex … \
  -c model_provider="nomi_gateway" \
  -c 'model_providers.nomi_gateway={ name="Nomi", base_url="http://127.0.0.1:18721/v1", wire_api="responses", env_key="NOMI_GATEWAY_KEY" }' \
  -c model="deepseek/deepseek-v4-pro"
```

再注入环境变量 `NOMI_GATEWAY_KEY=<codex 客户端令牌>`，以及 §12.7.1 的模型参数（`model_context_window`、`model_auto_compact_token_limit`）。

- `~/.codex/config.toml` 和 `auth.json` 都不写。官方账号切换改写的正是 `auth.json`（[官方账号 §5](cli-official-accounts.md)），两边不再碰同一个文件。
- 已实测（M0）：`-c` 可以写内联表，上面的写法直接可用；请求带 `Authorization: Bearer <NOMI_GATEWAY_KEY>`，`~/.codex` 不被改动。
- 已查证：Codex 原生会话列表按 `model_provider` 过滤，第三方会话在 Codex 官方视图里看不到；按 id 续接的查询不带供应商条件（§13.1）。Nomi 自己的历史列表不受影响。
- **已实测（M0）：用另一个供应商续接旧会话时，Codex 会把 `state_5.sqlite` 里这条会话的 `model_provider` 改成本次的供应商**（rollout 里的 `session_meta` 不变）。所以官方会话如果在 Nomi 里原地用第三方续接，它在 Codex 官方视图里会被归到 `nomi_gateway` 下。对策见 §13 第 5 条：Codex 的官方会话改用第三方时走副本。
- Codex 内部写死的模型名（如 `codex-auto-review`）走 §7.2 第 1 步映射到 `main`。

### 12.3 Gemini CLI

**现有做法在 Gemini CLI 0.65.0 上已经失效**（M0 实测）：0.65.0 只接受属于 root、且组和其他用户不可写的目录里的系统级设置文件，`userData` 里的文件会被跳过（「Skipping system settings file … is not owned by root」）；而且认证方式 `gateway` 不再通过校验（「Invalid auth method selected.」，`validateAuthMethod` 只认 `oauth-personal`、`compute-default-credentials`、`gemini-api-key`、`vertex-ai`）。所以现在用第三方的 Gemini 会话在 0.65.0 上启动不了，不必等网关上线，可以先单独修。

新做法全部用环境变量，不需要任何设置文件（已实测可用）：

| 环境变量                     | 值                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `GEMINI_CLI_AUTH_OVERRIDE`   | `gemini-api-key`（进程级覆盖认证方式，CLI 读取后会从自己的环境里删掉，不传给子进程）       |
| `GOOGLE_GEMINI_BASE_URL`     | `http://127.0.0.1:18721`                                                                   |
| `GEMINI_API_KEY`             | `gemini` 客户端令牌，以 `x-goog-api-key` 请求头发出                                        |
| `GEMINI_MODEL`               | `<provider/model>`                                                                         |
| `GEMINI_CLI_TRUST_WORKSPACE` | 不注入。Nomi 用的 ACP 模式不受工作区信任限制，只有 `-p` 无界面模式需要（终端启动命令不加） |

- 模型名里的 `/` 在请求路径里**不会**被转义（实测路径是 `/v1beta/models/google/gemini-3.8-flash:streamGenerateContent`）。网关的 Gemini 入口按 `/v1beta/models/` 之后、最后一个 `:` 之前的整段取模型名；也兼容 `%2F` 写法，先解码再按 §6.2 解析。转发给 Gemini 协议的上游时，`/` 原样放进路径，不转义（实测 amux 对 `%2F` 返回「Unknown model」）。
- ACP `session/load` 续接旧会话时，`GEMINI_MODEL` 生效，历史完整带上；运行中 `session/set_model` 可以切换到任意模型名（实测从 Gemini 切到 `z-ai/glm-5.3-flash` 后，下一轮请求就发往新模型，历史保留）。所以第三方之间换模型不需要重启进程，和 Claude、Grok 一致。
- 不写 `~/.gemini/settings.json`、`oauth_creds.json`、`google_accounts.json`，也不设 `GEMINI_CLI_HOME`，会话照常写进 `~/.gemini`，和官方会话共享历史。
- 0.65.0 的 `-p` 模式输出结果后进程不退出（直连 amux 也一样），Nomi 用 ACP 模式不受影响；终端启动命令要在 M0 回归里再确认一次。

### 12.4 Grok / dsh

- **dsh**：沿用 `--patch` 的进程级叠加配置（`dshModelPatch`）。叠加文件写在 Nomi 私有目录，内容为 `api: openai-responses`、网关地址、模型，令牌经 `NOMI_DSH_API_KEY` 注入。不再写 `$DSH_HOME/cordis.patch.yml`。
- **Grok**：现在写的是 `~/.grok/config.toml` 里带标记的一段，这是全局的，要改。M0 实测（Grok Build 1.0.62）：
  - 没有可用的进程级覆盖：命令行没有配置参数；二进制里有 `GROK_CONFIG_PATH`，但实测不影响模型配置，请求仍发往官方。
  - **采用 `GROK_HOME` 私有目录**（已实测可用）：第三方会话设 `GROK_HOME=userData/gateway/grok-home`，目录里放 Nomi 生成的 `config.toml`（`[model.nomi]` 加 `[models].default = "nomi"`，`api_backend`、网关地址、`env_key = "NOMI_GROK_API_KEY"`），不放 `auth.json`。官方的 `~/.grok/auth.json`、`config.toml` 都不动。
  - **会话目录用软链共享**（已实测可用）：私有目录里的 `sessions` 是指向 `~/.grok/sessions` 的软链，Grok 正常把会话写进去，所以第三方会话直接出现在原来的历史里，历史扫描不用加目录。`installed-plugins`、`bundled` 等也用软链指回，减少「看不到用户其他设置」的差异；`config.toml`、`auth.json`、锁文件不链。Windows 上用目录联接（junction）。
  - Grok 会用自己的内部模型名发旁路请求（实测生成会话标题时发 `grok-4.6`），网关按 §7.2 第 1 步把不认识的模型名映射到 `main`。

### 12.5 Nomi 对话

Nomi 自己的对话也作为网关的一个客户端（`nomi`），和 CLI 走同一条路径，回退、学习、修正、用量全部共用：

- `ai-runtime` 的 provider 工厂不再读 `ProviderStore`，改为向主进程要「当前角色的模型 + 首选入口协议」。首选入口协议 = §7.3 `pickWire` 对候选列表第一项算出的 wire，这样网关那一侧是同协议透传，没有转换损失。
- 按首选协议选 AI SDK 的实现（现有三种，见 `protocol.ts`）：`messages` → `@ai-sdk/anthropic`，`responses` → `@ai-sdk/openai` 的 `.responses()`，`chat` → `@ai-sdk/openai-compatible`；首选 `gemini` 时退回 `chat`。baseURL 指向网关，Key 用 `nomi` 客户端令牌。
- **就绪时序**：Nomi 启动时，在网关报告就绪之前发起的对话请求排队等待（最长 10 秒），超时再报错。网关崩溃重启期间同样排队等待。
- 网关进程长时间不可用时，对话给出明确错误，不绕过网关直连。这样只有一条代码路径，行为可预期。
- 原 `ProviderStore` 的多 Key 切换、模型映射、`thinking` 开关都由网关提供；`ProviderRouter.ts` 里 `RoutedLLMRegistry.resolve()` 按角色选供应商的逻辑删除，改为向网关取模型；`LLMRegistry` 接口（`bundle-ig-base/src/seams/llm.ts`）保持不变，插件宿主无感。

**实现记录（2026-10-21，M2 第 1 步）**：

- `RoutedLLMRegistry` 新增 `gateway` 选项：`resolve(role)` 先问网关（`GatewayService.nomiRoute`），网关没就绪或 `clients.nomi` 没有 main 时**过渡期退回旧存储**。旧存储里是迁移前的同一批供应商（还有环境变量供应商），M5 删除旧存储时去掉这条退路，同时补上「就绪前排队 10 秒」。
- 工具结果的接收者（`ToolCallProvider`）报真正的上游（网关供应商 id + 上游地址），不报网关的回环地址；首选或回退里只要有一个不在本机 / 局域网，就按云端算。桌面工具的本地 / 云端判断、云端同意都以它为准（`AIRuntimeBoot.resolveProvider / lookupProvider`）。
- 没有 Key 的本地服务（Ollama、LM Studio、llama.cpp）在快照里带一个空 Key，路由和探测都不发鉴权头。迁移时旧配置里的本机 / 局域网地址视为用户已确认。
- 跟着切换的入口：设置 →「模型」（正式上线，分配区先只有 Nomi 对话的 main / tools / summary）、对话区右上角的模型选择器、托盘「对话模型」、斜杠命令 `/model` `/status`、本机 llama.cpp「设为对话模型」、引导里的「添加第三方供应商」。知识库向量和云端语音识别的供应商列表合并了网关里有 Chat 地址的供应商，旧 id 继续可用。旧的 Nomi 供应商面板删除（编程助手页 Nomi 标签只留一个入口）；编程助手的第三方配置 M3 再并进来。

### 12.6 终端启动命令（可选，默认关）

满足「在终端里也想用第三方模型」，又不影响终端里的官方登录：

- 设置 → 模型 →「终端启动命令」开关。打开后，Nomi 在 `~/.nomi/bin/` 生成 `nomi-claude`、`nomi-codex`、`nomi-gemini`、`nomi-grok`、`nomi-dsh` 五个脚本。Windows 上生成 `.cmd`。
- 脚本做的事和 §12.1–§12.4 相同：设置环境变量和参数，然后 `exec` 真正的 CLI，用户的其余参数原样传过去。模型默认取 `clients.<cli>.models`，可以用 `--nomi-model provider/model` 临时指定。
- 令牌从 `userData/gateway/tokens/<cli>`（0600）读取，不写进脚本本身。这些文件是**明文**（shell 脚本要能读），和 `store.json` 里加密存储的 `tokenEnc` 策略不同；只有开启终端启动命令时才生成，关闭时删除。取舍写进 §15。
- 脚本先请求网关的 `/health`，网关没运行时给出明确提示（「请先打开 Nomi」），不让 CLI 报一个看不懂的连接错误。
- 只有在用户确认后才把 `~/.nomi/bin` 加进 PATH：在 `~/.zshrc` 等文件里写一段带标记的内容，关闭开关时删除。直接运行 `claude`、`codex` 等原命令，仍然是官方登录。

### 12.7 模型适配：让 GLM、DeepSeek 等模型在 Claude Code / Codex 里可用

这是本方案的**核心场景**：第三方选的是 GLM、DeepSeek、Kimi、Qwen、MiniMax 这类既不是 Anthropic 也不是 OpenAI 的模型，在 Claude Code 和 Codex 里也能直接用。协议转换（§9）只解决「格式对得上」；要做到「好用」，还要解决两件事：**CLI 不认识这些模型**，**这些模型的能力和限制与 Claude、GPT 不同**。

#### 12.7.1 告诉 CLI 模型的真实参数

两个 CLI 遇到不认识的模型名，都会按默认值猜它的上下文窗口和输出上限，导致压缩过早，或者上下文超长直接报错。查证（2026-10-21，Claude Code 2.1.306、Codex CLI 0.163.0）：

- Claude Code 对不认识的模型会**假设一个默认上下文窗口**，并按它自动压缩，除非设置了 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（它的提示文字原样写着「Claude Code doesn't recognize the model …, so it assumes a context window of …」）。
- Codex 的配置里有 `model_context_window`、`model_auto_compact_token_limit`、`model_catalog_json`。

所以启动第三方会话时，按模型元数据（§6.1 `GatewayModel`）一起注入：

| CLI         | 注入                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<ctx>`；`CLAUDE_CODE_MAX_OUTPUT_TOKENS=<maxOutput>`；推理模型 `MAX_THINKING_TOKENS=<推理预算>`，非推理模型 `MAX_THINKING_TOKENS=0`（实测会去掉请求里的 `thinking`）；每档模型的 `ANTHROPIC_DEFAULT_<档>_MODEL_SUPPORTED_CAPABILITIES`（格式见 §12.8）；`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（避免把与模型无关的旁路请求也发到第三方） |
| Codex       | `-c model_context_window=<ctx>`、`-c model_auto_compact_token_limit=<ctx × 0.8>`；推理模型保留 `model_reasoning_effort`，非推理模型不传；生成 `model_catalog_json` 文件（放在 Nomi 私有目录，`-c` 指向它，格式见 §12.8），否则每次启动都会警告「Model metadata for … not found」                                                                                              |

- Claude Code 的主模型、小模型、各档模型可能是不同模型，上下文取**主模型**的值。小模型窗口更小时，网关在请求超出时按 §9.6 返回「上下文超长」，让 Claude Code 压缩。
- 元数据缺失时（自定义模型、模型列表接口不返回），使用保守的默认值：上下文 128K、输出上限 8K，并在「模型」页提示用户补全。

#### 12.7.2 模型元数据从哪来

按优先级：

1. 用户在模型详情里手动填写的值；
2. 预设里为每个模型整理好的值（§8.4），在 M2 对首批厂商逐个核对官方文档，并记下查证日期；
3. 上游模型列表接口返回的字段（部分厂商会返回 `context_length` 等）；
4. 构建时内置一份公开模型目录的快照（候选：models.dev 的数据，引入前用 `pnpm check:licenses` 确认许可，登记 `assets-licenses.json`）。运行时不联网拉取。

#### 12.7.3 网关侧的请求修正

这些修正在**同协议路径上也要做**，用 §9.2 的外科式改写，不经过 IR：

| 修正                 | 规则                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输出上限             | `max_tokens` / `max_output_tokens` / `max_completion_tokens` 超过模型的 `maxOutput` 时，压到 `maxOutput`。Claude Code 常发 32000 或更大，DeepSeek 这类模型会直接 400                                |
| 推理预算             | Anthropic `thinking.budget_tokens` 必须小于 `max_tokens`，压低输出上限后要同步调整；非推理模型去掉 `thinking` / `reasoning` 参数                                                                    |
| 图片                 | 模型 `vision: false` 时，把图片块替换为一行文本「[图片已省略：当前模型不支持图片输入]」，不让整个请求 400；用量面板里记一条提示                                                                     |
| 工具 schema          | 按供应商的 `quirks.schema` 清理：去掉 `$schema`、`format`、`examples` 等不被接受的关键字；把 `oneOf` / `anyOf` 展平成上游能接受的形式；必要时去掉 `additionalProperties: false`。只改发给上游的副本 |
| 工具名               | Chat 上游要求 `^[a-zA-Z0-9_-]{1,64}$`：Codex 的命名空间工具（含 `.`）和超长的 MCP 工具名，映射成合法名字，回程按映射表还原                                                                          |
| 工具数量             | 超过 `quirks.maxTools`（如 128）时返回明确错误，提示用户减少 MCP 工具，不让上游返回难懂的 400                                                                                                       |
| 采样参数             | 按 `quirks.dropParams` 和 §7.4 学到的结果，去掉不被接受的 `temperature` / `top_p` / `top_k` 等，或者压到允许范围                                                                                    |
| 服务端工具           | Claude Code 的 WebSearch / WebFetch 依赖 Anthropic 服务端工具。上游不支持时，**单独发起的搜索请求**返回明确错误「当前模型不支持联网搜索」，不静默返回一个没有搜索结果的回答                         |
| User-Agent           | 同协议时透传 CLI 自己的 User-Agent（部分 Coding Plan 按它识别编程助手）；转换协议时用预设里的 `quirks.userAgent`                                                                                    |
| 对话中的 system 消息 | Claude Code 2.1.306 会在 `messages` 里放 `role: "system"` 的消息（实测，能力声明关不掉）。上游不是 Anthropic 官方时，合并进顶层 `system`，或者包成一条 user 文本，按 `quirks` 选择                  |
| Anthropic 专有字段   | 上游不是 Anthropic 官方时，去掉 `anthropic-beta` 请求头里上游不认识的项（如 `context-1m-…`）和 `output_config`、`context_management` 等字段                                                         |
| 加密推理请求         | Codex 每次都带 `include: ["reasoning.encrypted_content"]`（实测，`reasoning` 为空时也带）。转换到 Chat / Messages 时丢弃；同协议发往不支持的上游时按 §7.4 学到的结果去掉                            |

#### 12.7.4 Codex 接 GLM / DeepSeek 时走哪种协议

这些厂商一般不提供 Responses 接口，Codex 的请求只能转成 Chat 或 Anthropic。两者各有取舍：

- **转 Anthropic**：推理内容（thinking）和工具调用的结构保留得更完整。
- **转 Chat**：实现最普遍，但部分厂商在思考模式下要求回传 `reasoning_content`，见 §9.3。

所以不一刀切：预设的 `quirks.preferWire` 按厂商指定转换目标，这个值由 M2 验收矩阵（§17）的实测结果决定；没有指定时按 §7.3 规则 5。`pickWire` 在规则 5 之前读 `preferWire`。

#### 12.7.5 Coding Plan 类套餐

GLM Coding Plan、Kimi 的编程套餐等，Key 往往只能用专用地址，有的还校验客户端身份。处理：

- 预设里把套餐当作**独立的预设**（如「智谱 GLM Coding Plan」），写明专用地址；
- Key 只对某种协议有效时，用 `GatewayKey.wire` 限定（§6.1），探测时按 Key 记录（§8.2）；
- User-Agent 透传，见上表。

### 12.8 M0 实测记录

2026-10-21，macOS，Codex CLI 0.163.0、Claude Code 2.1.306、Grok Build 1.0.62、Gemini CLI 0.65.0、dsh 现有版本。Gemini 和推理内容两组用真实的第三方供应商 amux（`https://gateway.amux.ai/v1`，四种协议都支持）测，经本地记录代理转发，配置目录同样隔离。方法：本地起一个假上游（按三种协议返回最小的合法流式响应，并记录收到的请求头和正文），CLI 用隔离的配置目录（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`GROK_HOME`、`GEMINI_CLI_HOME` 指向临时目录）指向它，不改用户真实配置；除 amux 那两组外不消耗额度。

| 项目                                    | 结论                                                                                                                                                                                                                                                                                | 采用                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Codex `-c` 内联表                       | 可用，`env_key` 的令牌以 Bearer 发出                                                                                                                                                                                                                                                | 主方案（§12.2）                                                                                       |
| Codex 换供应商按 id 续接                | 可用；但 `threads.model_provider` 被改成本次供应商                                                                                                                                                                                                                                  | 官方会话走副本                                                                                        |
| Codex 副本 rollout 按新 id 续接         | 可用，历史完整                                                                                                                                                                                                                                                                      | 主方案（§13.1）                                                                                       |
| Codex `thread-writer-locks`             | 每会话一个 `.lock`，操作系统文件锁；冲突报 `already has an active writer`；强杀后锁文件残留但不阻塞                                                                                                                                                                                 | 按错误提示处理                                                                                        |
| Codex `model_catalog_json`              | 值是文件路径；文件格式与 `~/.codex/models_cache.json` 相同（`{"models":[…]}`，每项含 `slug`、`display_name`、`context_window`、`max_context_window`、`input_modalities`、`supported_reasoning_levels` 等）。传入后「Model metadata not found」警告消失                              | 主方案（§12.7.1）                                                                                     |
| Codex 会话键                            | `prompt_cache_key` = 请求头 `session-id` = thread id                                                                                                                                                                                                                                | §11.4                                                                                                 |
| Claude `API_KEY` 与 `AUTH_TOKEN` 并存   | 两个头都发：`Authorization: Bearer` 和 `x-api-key`                                                                                                                                                                                                                                  | 剔除继承变量（§12.0），网关不转发 `x-api-key`                                                         |
| Claude 默认模型                         | 不传 `--model` 时解析成 `sonnet[1m]`，带 `context-1m` beta                                                                                                                                                                                                                          | 必须显式传 `--model`（§12.1）                                                                         |
| Claude `_SUPPORTED_CAPABILITIES`        | 逗号分隔、不区分大小写；只在对应的 `ANTHROPIC_DEFAULT_<档>_MODEL` 与请求模型名一致时生效；一旦设置，没列出的能力视为不支持。可用的能力名：`thinking`、`adaptive_thinking`、`interleaved_thinking`、`effort`、`max_effort`、`xhigh_effort`、`temperature`、`mid_conversation_system` | 主方案（§12.7.1）；实测设置后请求里仍有 `thinking` 和 `role: system`，所以网关侧修正（§12.7.3）不能省 |
| Claude 关闭推理                         | `MAX_THINKING_TOKENS=0` 后请求不带 `thinking`                                                                                                                                                                                                                                       | 非推理模型注入                                                                                        |
| Claude 输出上限                         | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 直接决定 `max_tokens`                                                                                                                                                                                                                               | 主方案                                                                                                |
| Claude 副本 jsonl `--resume`            | 可用，历史完整                                                                                                                                                                                                                                                                      | 主方案（§13.1）                                                                                       |
| Claude 会话键                           | 请求头 `x-claude-code-session-id`；`metadata.user_id` 是含 `session_id` 的 JSON 字符串                                                                                                                                                                                              | §11.4                                                                                                 |
| Grok 进程级覆盖                         | 没有；`GROK_CONFIG_PATH` 不影响模型配置，请求仍发往官方                                                                                                                                                                                                                             | 退路：私有 `GROK_HOME`                                                                                |
| Grok 私有 `GROK_HOME`                   | 可用；`sessions` 软链回共享目录后，会话写进共享目录                                                                                                                                                                                                                                 | 主方案（§12.4）                                                                                       |
| Grok 旁路请求                           | 生成标题时用内部模型名 `grok-4.6`                                                                                                                                                                                                                                                   | 网关映射到 `main`                                                                                     |
| dsh                                     | 现有代码已经用 `--patch` 按进程叠加（`CliHarnessService.ts`）                                                                                                                                                                                                                       | 主方案                                                                                                |
| Gemini 系统级设置文件（0.65.0）         | 非 root 所有的目录被跳过；`gateway` 认证方式校验不通过。现有 Nomi 的 Gemini 第三方在 0.65.0 上不可用                                                                                                                                                                                | 改用 `GEMINI_CLI_AUTH_OVERRIDE=gemini-api-key`（§12.3）                                               |
| Gemini 经第三方                         | `GOOGLE_GEMINI_BASE_URL` 加 `GEMINI_API_KEY` 可用；模型名里的 `/` 不转义                                                                                                                                                                                                            | 主方案（§12.3）                                                                                       |
| Gemini `session/load` 与 `GEMINI_MODEL` | 生效，历史完整                                                                                                                                                                                                                                                                      | 主方案                                                                                                |
| Gemini `session/set_model`              | 运行中切换到任意模型名，下一轮生效                                                                                                                                                                                                                                                  | 第三方之间换模型不重启                                                                                |
| 推理内容跨模型、跨厂商（amux）          | amux 收下了伪造的 thinking 签名、别家的签名（发给 GLM）和别家的加密推理（发给 GLM），都返回 200，并在响应里注明丢弃了 `store`、`include` 等参数。说明它在中间自己清理请求。**这只是 amux 的行为**，官方接口和直连厂商会拒绝，所以网关仍然默认剥离，并保留被拒后重试（§9.3）         | 不据此放宽                                                                                            |

**未完成，需要后续处理**：

- **推理校验失败的错误特征**：唯一能用的第三方（amux）会自己清理请求，拿不到被拒时的错误文本。要用 Anthropic、OpenAI 官方接口或直连厂商（如 DeepSeek、智谱、Moonshot 官方地址）各发一次带别家签名或加密推理的请求，记录状态码和错误文本，补进 §9.3 的特征清单。在拿到之前，网关靠「默认剥离」保证正确，特征清单只影响被拒后重试能否命中。
- **Codex Desktop 的列表**：二进制里的列表查询带 `model_provider IN (…)` 条件，但 Desktop 实际传哪些供应商没法离线确认，需要在 Desktop 里人工看一次：用第三方续接过的会话是否还在列表里。

## 13. 与官方账号的边界

本方案**只管第三方供应商**。官方账号（多账号登录、导入当前登录、全局切换、回收刷新后的令牌、备份还原）的设计和实现保持 [官方账号](cli-official-accounts.md) 的现状。两者的边界如下：

| 方面       | 官方账号                                                                                                                                    | 第三方（本方案）                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 生效范围   | **全局**：改写 CLI 自己的凭据存储，终端里的 CLI 也跟着切                                                                                    | **单个会话**：只作用于 Nomi 启动的那一个 CLI 进程（§12.0）          |
| 动到的文件 | 钥匙串、`.credentials.json`、`~/.claude.json` 的 `oauthAccount`、`~/.codex/auth.json`、`~/.grok/auth.json`、`~/.gemini/oauth_creds.json` 等 | 只有 Nomi 自己的 `userData/gateway/*`，以及 Nomi 私有的叠加配置文件 |
| 流量       | CLI 直连官方，**不经过网关**                                                                                                                | 经过网关                                                            |
| 界面       | 现有 `OfficialAccounts` 界面和 `ai:cli-account:*` 通道，不改                                                                                | 「模型」页和 `ai:gateway:*` 通道                                    |

为了保证两边互不影响，规定如下：

1. **网关不读、不写、不转发任何官方凭据**。网关只认自己发出的客户端令牌（§10.2），其他 Bearer 一律返回 401；不提供「订阅当上游」或「官方与第三方共用一个进程」之类的模式。
2. **不再互斥**：官方账号切换流程的第 4 步「该 CLI 若启用了第三方供应商 → 自动停用」随本方案删除，因为第三方不再写全局配置，也就没有需要停用的东西。这是对官方账号流程唯一的改动，而且只是删掉一步。
3. **切换官方账号只影响官方会话**：`recycleBackend`（现在是按 CLI 种类回收全部标签）改为只处理来源为官方的标签；第三方标签不重启。另外新增按单个标签回收进程的 `recycleTab(tabId)`，供 §4.3 的来源切换使用（底层的 `teardownClaudeLive` / `teardownAcpLive` 等已有，缺的是按标签的编排）。
4. **每个标签各自选来源**：同一个 CLI 可以一个标签用官方账号（当前全局账号），另一个标签用第三方模型（§4.3）。
5. **切换来源和模型时怎么续接**（详见 §4.3 和 §13.1 第 4 条）：
   - 第三方之间换模型或换供应商：所有第三方会话连的都是同一个网关地址和令牌，换的只是模型名，所以**不重启进程**，用 CLI 自己的运行中切换（Claude 的 `set_model`、Codex app-server 每轮的 `model` 参数、Grok ACP 的 `session/set_model`）。网关在转发时剥掉不属于新供应商的加密推理和签名（§9.3）。新模型的上下文窗口或输出上限和旧模型差别大时（§12.7.1 的注入值要变），才重启进程并续接原会话。
   - 官方 → 第三方：重启该标签的进程并续接，网关负责剥掉官方的加密推理。Claude 续接原会话；**Codex 续接副本**（§13.1 第 4 条），因为 Codex 会把原会话在 `state_5.sqlite` 里的供应商改成 `nomi_gateway`（§12.2），原地续接会让它从 Codex 官方视图里消失。
   - 第三方 → 官方：网关不在路径上，第三方产生的推理内容到了官方接口会被拒绝，所以用副本或带上下文的新会话（§13.1 第 4 条）。
6. **用量分开统计**：官方会话的额度和用量继续由现有的用量卡片负责；网关的用量只统计第三方会话，按客户端令牌归属。

### 13.1 历史会话：跨账号、跨来源共享

**需求**：不管会话是哪个官方账号创建的，来自 Codex CLI、Codex Desktop、IDE 插件还是 Nomi，用的是官方还是第三方，都能在 Nomi 的历史列表里看到，并且能打开继续。

**查证**（2026-10-21，本机 Codex CLI 0.163.0）：

- Codex CLI、Codex Desktop（会话元信息 `originator: "Codex Desktop"`，`source: "vscode"`）、IDE 插件写的是**同一个目录**：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`，归档的移到 `$CODEX_HOME/archived_sessions/`。索引在 `$CODEX_HOME/state_5.sqlite` 的 `threads` 表。
- Nomi 切换官方账号只改写 `auth.json`，不改 `CODEX_HOME`，所以所有账号的会话文件都在同一个目录里。
- `threads` 表记录了 `model_provider`、`source`、`creator_user_id`、`creator_account_id`。本机 `source` 的取值有 `vscode`、`cli`、`exec`，以及子代理的 JSON（`{"subagent":{…}}`，如 guardian 审查、`thread_spawn` 派生）。
- Codex 自己的**会话列表**按 `model_provider` 过滤（SQL 里是 `threads.model_provider IN (...)`），没看到按账号过滤。因此：
  - 官方多账号之间，Codex 自己的列表本来就共享，因为它们的供应商都是 `openai`；
  - 官方和第三方之间（`openai` 与 `nomi_gateway`、cc-switch 写的 `custom` 等），Codex 原生的列表互相看不到。这是 Codex 的设计。
- Codex **按 id 找会话**：二进制里有 `SELECT rollout_path FROM threads WHERE id = ? AND archived = …`（条件里没有供应商）和按目录扫描的兜底 `find_thread_path_by_id_str_in_subdir`。M0 实测确认：换一个供应商按 id 续接可以成功；复制出的新 rollout（新文件名、内容里的旧 id 全部替换成新 id）也能按新 id 续接，完整带上之前的对话，Codex 随后把它补进 `threads` 表。
- 续接时 Codex 会把 `threads.model_provider` 改成本次的供应商（M0 实测，见 §12.2）。
- `thread-writer-locks` 的语义（M0 实测）：写会话时创建 `thread-writer-locks/<thread id>.lock`，靠操作系统的文件锁判断占用；第二个进程续接同一会话会失败，报 `thread <id> already has an active writer`（JSON-RPC `-32600`）。持锁进程被强杀后锁文件**会残留，但不再阻塞**，下一次续接正常。所以不能用「锁文件是否存在」判断占用。
- `$CODEX_HOME/thread_history_1.sqlite` 是 rollout 的投影（`thread_history_projection_state` 记录已投影到的字节偏移），会话内容以 rollout 为准，Nomi 不读它。
- Claude Code 的会话在 `~/.claude/projects/<cwd>/*.jsonl`，不区分账号。
- **Codex 会把旧会话压缩成 `rollout-*.jsonl.zst`**（续接时直接读压缩文件）。本机 `sessions/` 里 730 个会话文件有 709 个是压缩的，而 Nomi 原来只认 `.jsonl`，Codex 历史只能列出 21 条。`archived_sessions/` 里的归档会话也是压缩的，且续接前必须先 `codex unarchive`。
- `state_5.sqlite` 并不覆盖所有会话文件（较早的会话不在表里），表里的行也包含大量子代理会话（本机 515 个）。
- Nomi 原来的实现（`SessionHistoryService`）：扫 `sessions/`，不扫 `archived_sessions/`；上限 100（主进程 `SessionHistoryService.ts` 和渲染进程 `historyClient.ts` 各一份常量）；不读 sqlite；Codex 不解析 `originator` / `source` / `model_provider`，不过滤子代理；只有 Claude（`isSidechain`）和 Gemini（`kind === 'subagent'`）过滤子代理。

**设计**：Nomi 的历史列表作为「全部可见」的统一入口，Codex 原生列表的行为不改。

1. **列全**（不按供应商、账号过滤）（已实现）：
   - `sessions/` 下的 `.jsonl` 和 `.jsonl.zst` 都列出；**归档会话不列出**（用户决定，不做取消归档）；
   - 上限从 100 提到 500，主进程和渲染进程的两份常量一起改；搜索结果的渲染上限和索引上限拆开，仍最多显示 100 条；
   - Codex 优先只读打开 `state_5.sqlite` 读索引（标题、用户改过的名字、目录、模型、供应商、`source`、`originator`、账号），读取器是历史功能专用的 `cli/codexThreadIndex.ts`（`node:sqlite`，`readOnly: true`，先读表结构再选存在的列），不放进只允许读计量列的 `usage/sqliteRead.ts`；库文件指纹不变就复用；
   - 有索引的压缩会话不解压；没有索引的压缩会话在 4 MB 以内整份解压一次读元信息（按 mtime 缓存），更大的跳过；没有索引的 `.jsonl` 照旧解析文件头；
   - Codex 新增子代理过滤：**只过滤 `source` 是 `{"subagent":…}` 的会话**（索引里是 JSON 字符串，rollout 里是对象），其他取值一律列出；
   - 第三方 Grok 会话用私有 `GROK_HOME`，但 `sessions` 软链回 `~/.grok/sessions`（§12.4），历史扫描不用加目录；软链建立失败时退回扫描私有目录。
   - 实测：本机 Codex 历史从 21 条变为 209 条（全部主会话），一次列满约 120 ms。
2. **标出来源**（已实现标签与悬停提示，筛选待做）：行内只标出非官方线路（「第三方」或自定义供应商名），悬停提示里列出客户端、线路、账号：
   - **客户端**：取自 `originator` / `source`：`Codex Desktop` → Desktop，`codex_vscode` 或 `source=vscode` → IDE，`codex_exec` 或 `source=exec` → exec，`codex_cli_rs` 或 `source=cli` → CLI，`nomi` / `nomi-*` → Nomi；
   - **线路**：以索引里的 `model_provider` 为准（Codex 续接时会改写它），没有索引时用 rollout 的；`openai` 或为空（老版本没有这个字段）→ 官方；`nomi_gateway` → 第三方，具体供应商名从网关的「会话归属表」（§11.4）读，查不到就只显示「第三方」；其他自定义值 → 「其他第三方（`custom`）」；
   - **账号**：`creator_account_id` 对上保险箱里 Codex 账号的 `identity.org`（`adapters.ts` 把 ChatGPT 的 `account_id` 存在这里），或复合的 `identity.key` 里包含它时，显示邮箱；对不上或为空就不显示。`AccountService` 新增只返回身份元信息的 `findByAccountId(kind, id)`，不解密凭据（已实现）。本机所有会话的 `creator_account_id` 都为空，所以目前看不到账号标签。
3. **继续会话**：
   - 默认来源按会话记录推断：官方会话用**当前全局账号**继续（官方切换是全局的，可以接受）；`nomi_gateway` 会话按会话归属表里的模型继续，查不到就让用户选；其他自定义供应商的会话，弹出模型选择器让用户选第三方模型，或者选官方。
   - Nomi 只把会话 id 交给 CLI（Codex 是 app-server 的 `thread/resume` 或 `codex exec resume <id>`），由 CLI 自己找文件、写回。
   - 会话被别的应用占用时：Nomi 不预先检查锁文件（残留的锁文件不代表占用，见上面的查证），直接续接；收到 `already has an active writer` 时提示「该会话正在其他应用中打开」，不强行续接，也不删锁文件。
4. **推理内容和原账号、原线路绑定**（Codex 的 `encrypted_content`、Claude thinking 的签名）：
   - **第三方 → 第三方**（换供应商或换模型）：请求都经过网关，网关按 §9.3 在转发时自动剥掉不属于目标供应商的加密推理和签名，**原会话直接续接，不需要副本**。
   - **官方 → 第三方**：同样经过网关，由网关剥掉；重启该标签的进程。Claude 续接原会话；Codex 续接副本（下表），避免原会话被 Codex 改归到 `nomi_gateway`。
   - **第三方 → 官方**、**官方账号 A → 官方账号 B**：这时网关不在路径上，要由 Nomi 预先处理。按 CLI 分别处理：

     | CLI    | 处理                                                                                                                                                                                               |
     | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
     | Claude | 复制 `~/.claude/projects/<cwd>/<id>.jsonl` 为新 UUID 文件，把内容里的旧 `sessionId` 全部换成新 id，去掉 thinking 块及签名，然后 `--resume <新 id>`（M0 实测可用）                                  |
     | Codex  | 复制 rollout 为新 id（新文件名，内容里的旧 id 全部替换），去掉 reasoning 项的 `encrypted_content`，然后按新 id 续接（M0 实测可用）                                                                 |
     | 其他   | Gemini / Grok（ACP `session/load`）、dsh（`--session-id`，要求同一 cwd）的会话复制都没验证，**统一用现有的「带上下文新建会话」**（`carriedMessages` / `.carry.txt`），把可见消息作为前文发给新会话 |

     副本在 CLI 升级后如果失效，退回「带上下文新建会话」。副本的标题加「（副本）」后缀，历史列表里和原会话相邻显示。

   - 官方账号之间续接：先直接续接，**收到推理校验类 400 时**（错误特征需要用真实账号实测，见 §12.8 未完成项）再提示用副本或新建会话，不预先处理。
   - **原会话文件一律不改**，原账号和原客户端里照常可用。
5. **不做的事**：不修改 Codex 的 `state_5.sqlite` 或 rollout 里的 `model_provider` 去让 Codex 原生列表「看到全部」。那是 Codex 的内部数据，改了可能被它覆盖或者损坏索引。所以 Nomi 用第三方创建的 Codex 会话，在 Codex CLI 或 Desktop 的官方视图里看不到，要在 Nomi 里打开。

## 14. 用量与观测

- 网关每个请求结束时发出一条用量事件：客户端、入口协议、上游协议、供应商、Key 名、模型、四类 token（输入、输出、缓存读、缓存写）加推理 token、耗时、首字节时间、HTTP 状态、回退次数、用到的修正。
- `UsageService` 现在的 `routeBegin` 等接口扩展成接收上面这些字段；用量面板新增「按供应商 / 按 Key」维度，「缓存命中率」用缓存读 / (输入 + 缓存读) 计算。
- 请求日志：保留最近 200 条请求的元数据（不含提示词和回复内容），在用量面板里查看；「调试模式」开关打开后，可以额外记录请求和响应正文到 `userData/gateway/trace/`（脱敏 Key，24 小时自动删除，默认关）。
- 日志统一用 `createMainLogger`，绝不打印 Key 和令牌。

## 15. 安全

沿用现有约束，并补充：

- 客户端令牌在 `store.json` 里加密存储；只有开启终端启动命令时，才额外写出 0600 的明文令牌文件（§12.6）。令牌只能访问本机回环地址上的网关，泄露的影响限于本机其他进程能用用户的第三方额度，所以接受这个取舍；「重置令牌」可以随时作废。

- 网关只认自己的客户端令牌；请求里带的其他凭据（官方 OAuth 令牌等）一律不转发、不记录，直接 401（§13 第 1 条）。

- 只监听回环地址（`isLoopbackHost`）；Host 头校验防 DNS 重绑定（`isAllowedHostHeader`）；不设 CORS 头，拒绝带 `Origin` 的浏览器请求（`/health` 除外）。
- **上游地址校验**：探测和转发只访问用户配置的地址，**不跟随重定向，不跟随图片 URL 去下载**。按地址类型分两种：
  - **公网地址**：完整走 netGuard 的规则（只允许 http / https、拒绝内嵌凭据、连接时校验解析结果防 DNS 重绑定）。
  - **回环和私网地址**（Ollama、LM Studio、局域网里的自建服务）：netGuard 默认会拒绝，所以单独放行，但只放行用户**显式配置或确认过**的主机和端口（本地服务预设在添加时自动确认，自定义的私网地址在保存时弹窗确认）。连接时仍校验解析结果必须落在已确认的地址上。
  - 不允许上游地址指向网关自己的端口，防止请求转圈。
- netGuard 现在在 `electron/src/security/netGuard.ts`，只依赖 Node 内置模块。把它的校验核心搬到 `packages/gateway/src/net/`（纯 Node），electron 包改为从网关包导入，满足「网关不 import electron」的约束。
- Key 用 `safeStorage` 加密存储；解密只在主进程进行，通过 MessagePort 传给网关进程，网关进程只在内存里持有。
- 配置写入用 `writePrivateFile`；备份目录权限 0700。
- 新增的 IPC 通道都按 `ai:gateway:<动作>` 命名，走 `guardedHandle` 和 `ipcSenderGuard`：`ai:gateway:state`、`ai:gateway:upsert-provider`、`ai:gateway:remove-provider`、`ai:gateway:detect`、`ai:gateway:set-assignment`、`ai:gateway:reset-token`、`ai:gateway:clear-learned`、`ai:gateway:requests`、`ai:gateway:reimport-legacy`（§6.3 第 5 步），变更广播 `ai:gateway:changed`。返回给渲染进程的数据里 Key 只给掩码，令牌不返回。

## 16. 界面与文案约定

- 术语统一用「第三方供应商」。
- 所有中文文案作为 `t()` 的 key，英文同步加到 `packages/ui/src/locales/en.json`，用 `pnpm check:i18n` 检查。
- 供应商页和编程助手页同一行的控件用同一个高度令牌（`--cd-control-h-ms`）；协议徽标用现有的 `Badge` 组件 + `variant`，不在外部覆盖样式。
- 探测结果、回退提示要有 `aria-live`；弹窗支持 `Esc` 关闭并管理焦点。

## 17. 测试计划

| 层级         | 内容                                                                                                                                                                                                                                                                  | 位置                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 单元         | 4×4 请求转换矩阵：每个方向一组固定用例（文本、图片、并行工具、custom 工具、thinking 带签名、sealed、结构化输出、停止原因）；同协议往返字节一致                                                                                                                        | `packages/gateway/tests/ir/*`          |
| 单元         | 4×4 流式转换矩阵：录制的真实 SSE 片段作为输入，对输出做快照；断流、上游报错、JSON 回落成 SSE                                                                                                                                                                          | `packages/gateway/tests/stream/*`      |
| 单元         | `pickWire` 决策表、`resolve` 候选展开、回退与冷却（假时钟）、亲和、§7.4 学习、§11.3 每个修正                                                                                                                                                                          | `packages/gateway/tests/route/*`       |
| 单元         | 地址规范化表（20+ 种用户输入）、探测判定表                                                                                                                                                                                                                            | `packages/gateway/tests/probe/*`       |
| 单元         | 官方登录隔离：第三方会话启动前后，`~/.claude/settings.json`、`~/.claude.json`、`~/.codex/config.toml`、`~/.codex/auth.json`、`~/.gemini/*`、`~/.grok/*` 字节一致；官方会话的环境变量里没有网关变量；官方账号切换不重启第三方标签（扩展现有 `CliIsolation.test.ts`）   | `packages/electron/tests/unit/gateway` |
| 单元         | 历史共享：多账号（不同 `creator_account_id`）、多客户端（CLI / Desktop / IDE）、多供应商（`openai` / `nomi_gateway` / `custom`）、已归档的会话全部列出且标签正确；`state_5.sqlite` 读不到时退回解析文件；去掉推理内容的副本只去掉推理项和 thinking 块，原文件字节不变 | `packages/electron/tests/unit/cli`     |
| 单元         | 迁移：6 份旧存储（含 `ai-providers.json`）的各种组合 → 合并结果；撤销旧版本全局配置时只删 Nomi 写入的值，用户改过的值和官方登录字段不动                                                                                                                               | `packages/electron/tests/unit/gateway` |
| 集成         | 本地起 4 个模拟上游（各协议一个），网关跑完整的 Claude Code / Codex / Gemini 请求序列                                                                                                                                                                                 | `e2e/gateway.test.ts`                  |
| 真实应用     | 添加供应商 → 检测 → 选模型 → 在 Nomi 里分别用 Claude Code 和 Codex 跑一轮工具调用                                                                                                                                                                                     | `e2e-headed/`                          |
| 核心场景验收 | 见下方「核心场景验收矩阵」                                                                                                                                                                                                                                            | 验收清单 + `e2e-headed/`               |

**核心场景验收矩阵**（M2 定出 `preferWire`，M3 / M4 全部通过才算完成）：

- 客户端：Claude Code、Codex（Gemini CLI、Grok、dsh 各抽一个模型做冒烟）。
- 模型：GLM（含 Coding Plan）、DeepSeek（对话 + 推理）、Kimi、Qwen、MiniMax 各取一个主力模型。
- 每个组合跑以下场景：
  1. 多轮对话加并行工具调用（读文件、跑命令）；
  2. 改代码：Claude Code 的 Edit 工具、Codex 的 `apply_patch` 自定义工具；
  3. 开启推理，并且推理和工具调用交替出现；
  4. 发一张截图（模型不支持图片时不能报错，§12.7.3）；
  5. 长会话触发自动压缩，压缩时机符合模型的真实窗口（§12.7.1）；
  6. Claude Code 的子代理和后台小模型请求；
  7. 关掉再续接会话（§13.1）；
  8. 带一个 schema 复杂的 MCP 工具。
- Codex 的组合对 Chat 和 Anthropic 两种转换目标都跑一遍，按结果确定 `preferWire`。

真实 SSE 片段的来源：用真实供应商录制，录制后脱敏（去掉 Key、令牌、提示词中的个人信息）。

## 18. 里程碑

| 阶段              | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 完成标准                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 前置验证**   | 用当前版本实测所有「待实测」项：Codex `-c` 内联表、副本 rollout 能否按新 id 续接、`thread-writer-locks` 锁语义；Claude 副本 jsonl 能否 `--resume`、`ANTHROPIC_API_KEY` 与 `AUTH_TOKEN` 并存时的行为、`_SUPPORTED_CAPABILITIES` 格式；Grok 进程级覆盖；Gemini `session/load` 时 `GEMINI_MODEL` 是否生效；Codex `model_catalog_json` 格式；各类推理校验失败的错误特征                                                                                                                                                                                                                                                                                                                                                                                                             | 每一项写明结论、查证版本，以及采用主方案还是退路；结论写回 §12、§13.1。**2026-10-21 已完成离线部分**（§12.8），Gemini 已补测；剩推理校验错误特征（需要官方或直连厂商）、Codex Desktop 列表两项             |
| **H 历史共享**    | §13.1（列全、上限 500、来源标签已完成；筛选、副本续接待做）：压缩会话、上限 500、只读 `state_5.sqlite` 索引、来源 / 线路 / 账号标签与筛选、按会话推断续接来源、去掉推理内容的副本续接。依赖 M0 的 Codex 续接结论，不依赖网关，可以和 M1 并行，先合入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 切换官方账号前后，Nomi 历史列表里的会话数量和内容一致；Codex Desktop 创建的会话能在 Nomi 里继续，Desktop 里也能看到新增内容                                                                                |
| **M1 内核**       | **2026-10-21 已完成**：`packages/gateway` 建好，`transforms.ts` 与 `stream/` 迁入；请求方向改为 4 个解码器 + 4 个编码器（旧的两两转换函数成为薄包装，用旧实现逐条比对过，快照见 `tests/parity.test.ts`）；流式事件补齐推理、签名、加密推理、缓存用量（Messages / Responses / Chat 编码器暂不输出推理，保持现有 CLI 看到的内容不变；Gemini 编码器输出推理文本）；新增 Gemini 流式编码器和非流式聚合；入口按路径识别（`ingress.ts`），认不出的路径沿用旧判断；Gemini 上游路径保留模型名里的 `/`。唯一有意的行为差异：Messages 上游的 `refusal` 停止原因原样透传。count_tokens 仍按旧行为转发，留到 M4（§10.3）。原计划：新建 `packages/gateway`；IR + 4 个解码器 + 4 个编码器；流式事件补字段；入口按路径识别协议；迁移现有 `routing/` 和全部测试；仍在主进程运行，行为与现在一致 | 原有路由测试全部通过；4×4 矩阵测试通过；现有用户无感                                                                                                                                                       |
| **M1.5 界面原型** | 按 §4 做「模型」页、添加弹窗、`ModelPicker` 的可点击原型（假数据），先评审交互再接数据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 交互评审通过                                                                                                                                                                                               |
| **M2 供应商**     | **进行中**：存储、迁移、探测、utilityProcess 守护、Nomi 对话改走网关与「模型」页已完成（2026-10-21，见 §12.5 实现记录）；预设多地址、运行时学习、验收矩阵待做。`GatewayStore` + 迁移（含 `ai-providers.json`）；地址规范化 + 按 Key 探测；预设扩展为多地址；`pickWire` + 运行时学习；按模型名路由；**网关迁到 utilityProcess**，打通配置快照推送（全仓第一次用 `MessageChannelMain`）和就绪时序；Nomi 对话改走网关（§12.5）；**列出 `LLMRegistry.resolve()` 的所有调用方逐一确认**（对话、agent-tools、summary、插件宿主）；首批厂商预设补全模型元数据和 `quirks`（§8.4）；跑验收矩阵的协议部分，定出各厂商的 `preferWire`                                                                                                                                                      | 旧配置自动合并；新增供应商无需选协议；同一个供应商能同时服务 Nomi、Claude Code 和 Codex；网关崩溃重启时 Nomi 对话自动恢复；GLM、DeepSeek、Kimi、Qwen、MiniMax 的预设元数据都有查证日期                     |
| **M3 接入**       | 先实测 §12 各 CLI 的进程级注入方式并记下版本；`buildCliEnv` 按标签来源注入或剥离网关变量；标签来源菜单与切换规则（§4.3）；客户端令牌；撤销旧版本写进全局配置的第三方设置（§6.3 第 7 步）；删除官方账号切换流程里「自动停用第三方」一步；`recycleBackend` 只处理官方标签，新增 `recycleTab(tabId)`；第三方之间换模型走运行中切换（§13 第 5 条）；模型参数注入（§12.7.1，先实测 `_SUPPORTED_CAPABILITIES` 和 `model_catalog_json` 的格式）；§12.7.3 的请求修正                                                                                                                                                                                                                                                                                                                    | 5 个 CLI 都能在 Nomi 标签里用同一个供应商；同一个 CLI 一个标签用官方账号、一个标签用第三方，互不影响；官方账号的多账号切换回归测试全部通过；全局配置文件在第三方会话前后字节一致；核心场景验收矩阵全部通过 |
| **M4 可靠性**     | 回退与冷却（按 Key × wire）、多 Key、亲和、流式空闲超时、count_tokens 校准、§11.3 全部修正、错误映射                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 模拟上游 429 / 5xx / 断流 / 静默的集成测试通过                                                                                                                                                             |
| **M5 界面与观测** | 落地 §4 全部界面：「模型」页、添加弹窗、`ModelPicker` 替换对话框和托盘的旧控件；删除 §4.6 列出的旧界面和旧 IPC；用量新维度、请求日志；更新 `docs/features/providers.md` 和截图                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 真实应用 E2E 通过；手工验收清单通过；仓库里不再有 `cli-provider` 字样                                                                                                                                      |
| P3（待评估）      | 路由组、`previous_response_id` 本地重建                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                          |

每个阶段单独提 PR，加 changeset。M1 不改界面、不改用户配置，可以先合入。

## 19. 风险与待定问题

| #   | 问题                                                                                                                       | 处理                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 探测会消耗少量 token；个别中转站按次计费                                                                                   | 界面写明；只在用户点击、迁移、学习过期时探测；提供「只拉模型列表，不探测」的选项                                                                                |
| R2  | 中转站返回的错误格式五花八门，§7.4 的学习可能误判                                                                          | 短期压制只影响排序、10 分钟过期；升级成 `wireDown` 需要多模型连续命中并经探测确认，TTL 1 小时；都可以在界面清除                                                 |
| R3  | Codex 的 `-c` 内联表、副本续接，Grok 进程级覆盖，Gemini 续接时的模型等外部行为随版本变化                                   | 全部放进 M0 前置验证，按结论选主方案或退路，退路已写在 §12、§13.1；每次升级 CLI 后回归                                                                          |
| R4  | Claude Code 的 env 键随版本增减（如 `FABLE` 档）                                                                           | 键名集中在 `agents/claude.ts` 一处；每次升级 Claude Code 后回归测试                                                                                             |
| R5  | 用户自己在 shell 里导出了 `ANTHROPIC_*` / `OPENAI_*`，或用了 cc-switch 等工具改全局配置                                    | 本方案不写全局配置，不会和它们冲突；第三方会话的注入值覆盖继承来的同名变量，官方会话照常继承用户自己的变量                                                      |
| R6  | utilityProcess 崩溃导致所有 CLI 同时不可用                                                                                 | 守护进程自动重启；崩溃时 Nomi 内的会话给出明确提示                                                                                                              |
| Q1  | 要不要保留「直连模式」（CLI 不经网关直连供应商）？                                                                         | **不保留**（交互可以推翻，2026-10-21）：同协议透传的额外延迟可以忽略，保留会让配置又分裂成两套                                                                  |
| R7  | Nomi 对话也依赖网关进程，网关出问题时对话一起不可用                                                                        | 守护重启 + 明确报错（§12.5）；M4 的崩溃恢复测试覆盖 Nomi 对话                                                                                                   |
| R8  | 换账号或换线路后续接，推理内容（加密推理项、thinking 签名）校验失败被拒                                                    | 经过网关的方向由网关按会话归属表剥离（§9.3、§11.4）；第三方 → 官方、官方账号之间用副本或带上下文的新会话（§13.1 第 4 条）；原会话文件不改；错误特征 M0 实测补全 |
| R10 | Codex 的 `state_5.sqlite` 表结构随版本变化（文件名里的 5 就是版本号）                                                      | 只读打开，按列名取值；表或列不存在时退回解析 rollout 文件；每次升级 Codex 后跑历史共享回归                                                                      |
| R11 | 各厂商的模型参数、Coding Plan 地址、schema 限制变化快，预设里的元数据会过期                                                | 预设写查证日期；运行时遇到上下文超长、`max_tokens` 超限、schema 被拒时按 §7.4 学习并提示用户更新；每个版本发布前重跑核心场景验收矩阵                            |
| R12 | Claude Code 和 Codex 内部针对 Claude、GPT 做的优化（提示词、工具设计）对其他模型不一定适用，「能用」但效果可能不如原厂模型 | 不在网关里改写提示词；只保证协议、参数、能力层面正确。效果差异在模型选择器里用能力标签提示                                                                      |
| R9  | 撤销旧版本写进全局配置的第三方设置后，原本在终端里用第三方的用户会觉得「不能用了」                                         | 撤销后一次性提示，并引导开启终端启动命令（§12.6）                                                                                                               |
| Q2  | 模型名前缀用供应商 id 还是显示名？                                                                                         | 建议用 id（稳定、URL 安全），界面显示「显示名 / 模型名」                                                                                                        |

## 20. 明确不做（本阶段）

- 任何涉及官方账号的改动：多账号登录、切换、凭据存储都保持现状（§13）；唯一的变化是删掉切换流程里「自动停用第三方」这一步。
- 改写 CLI 全局配置让终端里的原命令走第三方（用 §12.6 的启动命令代替）。
- 订阅账号当上游、官方与第三方混用同一个进程、局域网共享、远程网关、意图路由、联网搜索代理、生图（§2.2）。
- Embeddings、音频、图片生成、realtime 接口。
- 价格表和花费计算：沿用用量面板现有的能力，不在网关里实现。

## 21. 评审意见处理（2026-10-21）

| 意见                                                                                                    | 处理                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| netGuard 会拒绝 Ollama 等本地服务                                                                       | 采纳：公网 / 私网分开校验，私网只放行用户确认过的地址；netGuard 核心搬进网关包（§15） |
| `wireDown` 24 小时与「误判只多一次重试」矛盾                                                            | 采纳：短期压制 + 多次确认后升级，TTL 改为 1 小时（§7.4、R2）                          |
| count_tokens 纯估算影响压缩时机                                                                         | 采纳：用真实用量按消息前缀校准（§10.3）                                               |
| 裸模型名在多供应商下歧义 404                                                                            | 采纳：客户端主模型的供应商作为命名空间优先，`claude-*` 内置名按档位兜底（§6.2）       |
| 迁移期旧令牌没有客户端身份                                                                              | 调整后采纳：只在旧全局配置撤销前接受，身份按入口路径推断，撤销后失效（§10.2）         |
| 探测和冷却要区分 Key × 协议                                                                             | 采纳：按 Key 探测；冷却维度改为 (供应商, Key, wire)（§8.2、§11.1）                    |
| 同协议「透传原始字节」不准确                                                                            | 采纳：改为「绝不经过类型化 IR、外科式改写、不丢字段」（§9.2）                         |
| 首字节之后没有空闲超时                                                                                  | 采纳：流式空闲 180 秒超时（§11.1）                                                    |
| 网关就绪时序、MessagePort 是新基础设施                                                                  | 采纳：就绪前排队 10 秒；utilityProcess 和快照推送提前到 M2（§12.5、§18）              |
| `responsesTellsCache` 无字段、令牌类型、漏通道                                                          | 采纳：新增 `quirks`、`tokenEnc`、`ai:gateway:reimport-legacy`（§6.1、§15）            |
| 自定义端口迁移                                                                                          | 采纳（§6.3 第 8 步）                                                                  |
| 审计 `LLMRegistry` 的全部消费方                                                                         | 采纳：列入 M2（§18）                                                                  |
| Gemini `~/.gemini/.env` 方案未实现                                                                      | 已过时：方案已改为进程级注入；§12.3 对齐到现有 `geminiEnv()` 的变量名                 |
| 事实措辞（P5、`ModelControls`、`RoutedLLMRegistry`、私有函数位置、`NOMI_GROK_API_KEY`、预设已有单地址） | 采纳，已逐条修正                                                                      |

### 21.1 第二轮评审（2026-10-21）

| 意见                                                | 处理                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 加密推理和供应商绑定，第三方之间同协议切换会 400    | 采纳：新增持久化的会话归属表（§11.4），供应商变化时网关在转发前剥离加密推理和签名（§9.3）；第三方之间切换因此不需要副本   |
| `GROK_HOME` 退路会让会话从历史里消失                | 采纳：历史扫描加入私有目录；Grok 进程级覆盖放进 M0（§12.4、§13.1）                                                        |
| H 阶段依赖未验证的 Codex 行为                       | 采纳：新增 M0 前置验证；已从二进制查到按 id 查找的 SQL 不带供应商条件，作为旁证写入 §13.1                                 |
| 副本续接只写了 Codex                                | 采纳：按 CLI 写明；Gemini / Grok / dsh 统一用现有的「带上下文新建会话」；副本只在第三方 → 官方、官方账号之间需要（§13.1） |
| 账号字段是 `identity.org` 不是 `identity.accountId` | 采纳，并新增只返回身份元信息的 `findByAccountId`（§13.1）                                                                 |
| `TabSource` 位置写错、没复用 `modelScope`           | 采纳：加进 `HarnessTabMeta`，存在 `tabs.json`；复用 `modelScope` / `modelByScope`（§6.1）                                 |
| 继承来的 `ANTHROPIC_API_KEY` 等                     | 采纳：第三方会话显式删除会抢鉴权的继承变量（§12.0）                                                                       |
| 换模型不必重启进程                                  | 采纳：第三方之间走运行中切换，只有模型参数差别大时才重启（§13 第 5 条、§4.3）                                             |
| 需要按标签回收进程                                  | 采纳：`recycleTab(tabId)` 列入 M3（§13 第 3 条）                                                                          |
| 旧令牌 `chat → grok` 有歧义                         | 采纳：再按 User-Agent 区分，区分不了记为未知客户端（§10.2）                                                               |
| count_tokens 校准要带供应商和模型                   | 采纳（§10.3）                                                                                                             |
| `unpatch*` 的删除时机                               | 采纳：保留到迁移入口移除为止（§5.2）                                                                                      |
| 复用 `node:sqlite` 先例                             | 采纳：复用 `usage/sqliteRead.ts`（§13.1）                                                                                 |
| Codex 子代理过滤是新增能力                          | 采纳：只过滤 `source` 为 `{"subagent":…}` 的会话，取值来自本机实测（§13.1）                                               |
| 终端令牌文件是明文                                  | 采纳：在 §12.6、§15 写明取舍；脚本先查 `/health`                                                                          |
| 历史里的供应商名没有数据来源                        | 采纳：来自会话归属表（§11.4）                                                                                             |
| 网关的打包方式                                      | 采纳（§5.3）                                                                                                              |
| Gemini `session/load` 时 `GEMINI_MODEL` 是否生效    | 采纳：列入 M0（§12.3）                                                                                                    |
