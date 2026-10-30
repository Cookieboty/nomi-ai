# 「按端」左下角信息卡设计

状态：设计稿（原型截图见 `docs/screenshots/design-endpoint-card/`），实现见本分支。关联：[订阅额度卡片](usage-quota-cards.md)。

## 1. 目标与位置

开发模式侧栏有「全部 / 按端」切换。**按端**时顶部显示 Nomi / Claude Code / Codex / dsh / Grok 分组。选中某一端后，左下角固定一张**端信息卡**，回答「这个端现在什么状态、还剩多少额度、今天花了多少」，点击打开详情抽屉。

- 位置：侧栏 `nav` 滚动区**下方的固定区**（不随会话列表滚动，也不挤占「编程助手历史会话」的滚动区）。
- 仅在 `开发模式 + 按端 + 侧栏展开 + 未在搜索` 时显示；`全部` 视图、普通模式、折叠态、搜索态都不显示。
- 切换端点分组时卡片跟着切换；每次只展示一个端。

## 2. 信息架构

```mermaid
flowchart LR
  subgraph 数据来源(都是本机、不读凭据)
    A[harness state.bins: 是否安装/路径]
    B[cli-update inspect: 版本/最新版/可更新]
    C[usage quota: 登录方式/套餐/额度窗口]
    D[usage endpoint: 今日/7日/趋势/最近活动]
    E[CLI 配置路径]
    F[harness tabs: 运行中标签数]
  end
  A & B & C & D & E & F --> Card[端信息卡 (左下角, 紧凑)]
  Card -->|点击| Drawer[详情抽屉 (右侧, 完整)]
```

### 2.1 卡片（紧凑）

```
┌──────────────────────────────┐
│ ◎ Codex  v0.46.0   [已安装] [↻] │  图标 / 名称 / 版本 / 安装状态 / 本端刷新
│ [账号登录] [Plus] [运行中 1]     │  登录方式 / 套餐 / 运行中标签数
│ 5 小时 ▓▓▓░░░░░░░ 32%           │  迷你进度条（最多 2 个窗口）
│ 每周   ▓▓▓▓▓▓▓░░░ 74%           │
│ 今日 12.3K · $0.12     2 小时前 │  今日用量与费用 / 最近活动
└──────────────────────────────┘
```

| 字段            | 来源                                                                                                     | 缺省 / 异常表现                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 图标 / 名称     | `EndpointIcon` + `ENDPOINT_FULL`                                                                         | —                                                                               |
| 版本            | `cli-update inspect`（`--version`）                                                                      | Nomi：显示“内置”；未知：不显示                                                  |
| 安装状态        | `harness bins[端]`                                                                                       | 未安装 → 灰色“未安装”，其余区块隐藏，只留“去安装”入口（跳设置 → 编程助手）      |
| 登录方式        | 额度条目 `auth`（官方登录状态）                                                                          | `账号登录 / API 密钥 / 未确认`；Nomi、dsh 固定 API                              |
| 套餐            | 额度条目 `plan`                                                                                          | 无则不显示                                                                      |
| 额度迷你条      | 额度条目 `windows`（取前 2）                                                                             | API 计费 → “API 计费，无订阅额度”；无数据 → “暂无额度数据”；窗口已重置 → 不画条 |
| 今日用量 / 费用 | `usage endpoint.today`                                                                                   | 无调用 → “今日暂无用量”                                                         |
| 运行中标签数    | `harness tabs`（status = running / queued）                                                              | 0 不显示徽标                                                                    |
| 最近活动        | `usage endpoint.lastActivityAt` 与该端标签 `updatedAt` 取较新者                                          | 没有 → “暂无活动”                                                               |
| 刷新            | 额度类端（claude / codex / grok）：只刷新该端额度（`quota-refresh(tool)`）+ 重取用量；其他端：只重取用量 | 加载中禁用并旋转；失败显示红色提示                                              |

交互与可访问性：整张卡片是一个按钮（`aria-label` “查看 Codex 详情”），内部刷新按钮单独可聚焦；刷新按钮点击不触发打开；`Enter / Space` 打开；动画遵守 `prefers-reduced-motion`。

### 2.2 详情抽屉（完整）

沿用项目抽屉规范（`ModalHostContext mode="drawer"`）：**从标题栏下方开始**，右侧滑出，头部右上角是文字按钮「关闭」，`Esc` 关闭，焦点陷阱与回收。

| 区块          | 内容                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 概况          | 安装状态、CLI 版本、最新版本与“可更新”提示、登录方式、套餐、运行中标签数、最近活动                                      |
| 订阅额度      | 与用量页同一组件：全部窗口（5 小时 / 每周 / …）进度条 + 重置倒计时；来源说明；**本端刷新**按钮 + 加载 / 失败 / 更新时间 |
| 今日与近 7 天 | 今日 Token / 费用、近 7 天费用、近 7 天按天趋势（迷你柱状）                                                             |
| 配置          | **只显示路径**（如 `~/.codex/config.toml`），不读取、不展示内容；说明“登录凭据由官方 CLI 保管”                          |
| 底部操作      | 「打开用量页」→ 设置 → 用量与费用；「打开编程助手设置」→ 设置 → 编程助手                                                |

## 3. 原型截图

- `01-sidebar-card.png`：Codex 被选中，左下角固定信息卡。
- `02-detail-drawer.png`：点击后右侧抽屉（标题栏下方开始、文字“关闭”）。
- `prototype.html`：HTML 原型（仅设计用，不进入产品）。

## 4. 非目标

- 不展示邮箱 / 账号 id / Token；不读 `auth.json`、`.credentials.json`、钥匙串。
- 不新增自动轮询；额度仍只在用户点刷新时才让官方 CLI 去取（同一工具 60 秒节流）。
- 不改动画 / 诺米 / rig 相关文件。

## 5. 实现与验证

- 实现：`packages/ai-chat/src/components/EndpointInfo/`（卡片 + 抽屉）、`hooks/useEndpointInfo.ts`、主进程 `ai:usage:endpoint`（只读本机账本）。安装状态以编程助手接入检测（`bins`）为准，缺省才回退到 CLI 版本信息。
- 单测：`packages/ai-chat/tests/endpointInfo.test.tsx`、`historySidebar.test.tsx`；主进程 `UsageService.test.ts`、`quotaRefresh.test.ts`。
- 有头 e2e：`e2e-headed/tests/E26.usage-cards-endpoint.headed.spec.ts`（`xvfb-run`，`CD_TTS=off`，种子数据写在临时 `CODEX_HOME` / userData，不碰真实 CLI 配置）；截图目录用 `USAGE_CARDS_SHOTS_DIR` 指定。
- 未验证：真实 CLI（`codex app-server` / `claude -p /usage` / Grok ACP）在真机上的单卡刷新；Windows / macOS；检查更新实际访问 npm。
