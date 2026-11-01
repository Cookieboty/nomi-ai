# 持续任务：实施计划（2.1.0）

> 状态：**执行中**（computer use 搁置，其余按本计划推进）；起草 2026-11-01。依据：[持续任务设计稿](persistent-tasks.md)（下称「设计稿」）+ 外部分析
> 《Multica vs Nomi 深度对比 v2》（结合 DeepSeek《Super-agent 设计探索》，下称「分析」）。
> 外部账号与本机软件（GitHub、MCP、computer use）统一由 [连接设计稿](connections.md) 承载。
> 外部项目调研与据此做的改动见 [参考与取舍](persistent-tasks-references.md)。
> 原则：设计稿是主线，分析只用来**补漏、排序、划边界**；不因分析扩大 2.1.0 范围。

## 1. 两份文档怎么对上

分析的每条建议在设计稿里的位置：

| 分析条目                                 | 设计稿对应                                         | 处理                                                                                 |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P0-1 审核闸门（不自动回填）              | §5.4 `awaiting_accept`、§7.2 回填是单独动作        | **已覆盖**，第 2 期交付；后台委派 = 任务，自然走验收                                 |
| P0-2 `delegate_stop`                     | 无（只有 `tasks.cancel` 契约）                     | **补进第 2 期**：Nomi 工具 `delegate_stop`，内部走 `tasks.cancel`                    |
| P0-2 超出并发时排队而非拒绝              | §5.1 `queued`、§7.2 并发上限一视同仁               | **已覆盖**；`DelegateService.ts:903` 的拒绝改为入队                                  |
| P0-2 完成事件合并成一条                  | §11 免打扰期间合并                                 | **补一条**：同一时间窗内多个结果合并投递（不只免打扰时）                             |
| P0-2 程序级强制委派（routingPolicy）     | 无                                                 | **不进 2.1.0**；第 0 步只埋点测委派率基线                                            |
| P0-3 任务对象 + 引用 ID + 收件箱         | §4、§11 收件箱、§12                                | **已覆盖**；补 `task_recall(id)` 只读工具（第 1 期，成本低）                         |
| P1-1 Trigger + 两级过滤 + 默认只记录     | §6 事件源（有程序过滤，无语义过滤、无「只记录」）  | 第 3 期；**补** `mode: 'observe' \| 'act'`，事件任务默认 `observe`；语义过滤放 2.1.x |
| P1-1 GitHub 复用 `gh` 登录               | §6.4 原建议单独 token                              | **改为允许复用**，统一由「连接」承载，见 [connections.md](connections.md) §4         |
| P1-2 Watchdog 失败分类 / 重试 / 续跑     | §5.2 失败可重试 → `queued`；§10.3 同 worktree 续跑 | 第 2 期补**错误码枚举**与瞬时错误重试一次；语义级 Watchdog（无进展、偏题）放 2.1.x   |
| P1-3 Router 快模型、Worker 强模型        | §4.2 `ExecutorSpec.model` 可单独指定               | 不改架构；任务创建时 `cli` 执行者默认取该 CLI 推荐的强模型，作为默认值即可           |
| P1-5 IM 通知与审批                       | §11 Outbox 投递目标                                | 不进 2.1.0；Outbox 的 `target` 设计成可扩展枚举，为 IM 留口                          |
| P1-6 按任务归因成本                      | §9                                                 | **已覆盖**，第 1 期                                                                  |
| P2-1 常驻无头模式                        | §1「不做」                                         | 不做                                                                                 |
| P2-2 Thread 直通                         | §6.3「执行中来新事件 → 排队合并」                  | 2.1.x 再议                                                                           |
| 风险：主动 = 攻击面（外部 Trigger 降档） | §8.4 事件任务一开始就算读过外部内容                | **已覆盖**，复用 `markExternalRead`（`core/src/desktop/plugin.ts`）                  |
| 风险：JSON 存储规模                      | §4.3 每任务一个文件 + jsonl                        | 规模几百以内够用；归档阈值第 1 期定                                                  |

结论：设计稿已经覆盖分析的大部分 P0；需要**补进设计稿**的有 5 处：`delegate_stop`、结果合并投递、
`task_recall`、事件任务 `observe` 模式、委派错误码枚举。

## 2. 第 0 步：开工前（约 2 天）

- [ ] 定 §18 待决定项（建议值）：
  1. 预算：每次执行 20 万 token / 30 分钟；每日 1 美元；授权 30 天（按设计稿建议）。
  2. GitHub：**允许复用本机 `gh` 登录**（已定），也可粘贴细粒度令牌；见 connections.md §4。
  3. 阻止休眠：提供，默认关。
  4. 历史执行：每任务保留最近 50 次，超出归档压缩。
  5. 第 3、4 期与连接 C3 进入 2.1.0，排在第 1、2 期之后；computer use 搁置。
- [ ] 把 §1 结论里的 5 处补充写进 `persistent-tasks.md`（§5.2、§6、§7.2、§11、§14），状态改为「已评审」。
- [ ] 评审 [connections.md](connections.md)，定其 §12 待决定项（原生辅助程序选型可推迟到 C4 前）。
- [ ] 埋点：记录「编程类请求是否委派」，留作以后评估强制委派的基线（只记本地用量统计，不上报）。

## 3. 第 1 期：任务模型 + 定时 + Nomi 只读执行

每个工作包 Node 与 Go 同时交付，先写用例。

| #    | 工作包                                                                        | Node（`internal/core/src`）                                                                                                | Go（`internal/core`）                          | 测试 / 验收                                                                     |
| ---- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| 1.1  | 状态机纯函数 ✅                                                               | `tasks/machine.ts`（`transition → {task, attempt, effects}`）                                                              | `tasks/machine.go`                             | 每个转换 + 非法转换 + 代次丢弃 + 撤销检查点；`scripts/parity` 加 golden         |
| 1.2  | 存储与事件日志 ✅                                                             | `tasks/TaskStore.ts`（`privateFile` 原子写 + `.events.jsonl`）                                                             | `tasks/store.go`                               | 每个写入点注入崩溃；Node 写 Go 读、Go 写 Node 读                                |
| 1.3  | 运行时：定时、并发、预算 ✅                                                   | `tasks/TaskRuntime.ts`（复用 `schedule/recurrence.ts`）                                                                    | `tasks/runtime.go`（复用 recurrence）          | 错过 12 小时内补跑一次；并发上限；预算用完 → `waiting_user`                     |
| 1.4  | `notify` 执行者；提醒 / 定时并入任务页（调整） ✅                             | `tasks/executors/notify.ts`；`tasks/legacy.ts`：提醒、定时代理任务的只读适配器（数据迁移推迟，见设计稿 §13）               | `tasks/executors/notify.go`、`tasks/legacy.go` | 通知走免打扰；适配器字段映射用例；旧功能回归不变                                |
| 1.5  | 契约 `tasks` 域（放在 D4） ✅                                                 | `packages/contract/src/app/tasks.ts`；`contract/tasks.ts`                                                                  | `taskshandlers/`                               | list/get/inbox/create/update/pause/resume/cancel/runNow + `tasks.changed`       |
| 1.6  | Nomi 无界面执行（L1） ✅                                                      | `tasks/executors/nomi.ts`：`runNomiTask`、`task_report`；授权含 `github.read` 时提供只读 GitHub 工具（经 Broker）          | `tasks/executors/nomi.go`                      | 模拟网关：工具按授权裁剪；只读轨迹会话不进对话列表                              |
| 1.7  | 用量归属 ✅（每次执行的用量与每日预算已做；网关请求日志按任务打标记留作后续） | `usage/` 记账带 `taskId` / `attemptId`                                                                                     | `usage/`                                       | 费用未知显示「未知」；用量页按任务分组                                          |
| 1.8  | `task_propose` + 授权卡片 ✅                                                  | Nomi 工具；卡片走现有确认组件                                                                                              | `igtools_wiring.go` 注册同名工具               | Nomi 不能给自己授权；外部内容声称已授权无效                                     |
| 1.9  | `task_recall`（补充） ✅                                                      | 只读工具：返回任务摘要 + 关联 id                                                                                           | 同                                             | 不泄露密钥；结果长度上限                                                        |
| 1.10 | Outbox + 投递 + 免打扰 ✅（投递到来源对话留作后续；结果在任务详情与通知里）   | `tasks/outbox.ts`；复用 `DesktopService.notify`、免打扰设置                                                                | 对应                                           | 重启重发不重跑任务；同窗口多结果合并成一条                                      |
| 1.11 | 视图 ✅                                                                       | `packages/ai-chat/src/components/Tasks/*`：入口角标、列表、详情、收件箱、新建表单                                          | 共用                                           | i18n（en.json）、`check:frontend`、无障碍；设置里「定时任务」「提醒」改指向     |
| 1.12 | 重启核对（none / local） ✅                                                   | `TaskRuntime` 启动流程                                                                                                     | 对应                                           | 中断执行自动重新排队，带进度摘要                                                |
| 1.13 | 连接 C1（新增）                                                               | `connections/`：Store、能力目录、Broker；GitHub 适配器（`gh` 登录 / 令牌，`github.read`）；设置 → 连接；契约 `connections` | `connections/`、`connectionshandlers/`         | 不读 `gh auth token`；scopes 宽权限警告；账号切换后执行失败并提示；令牌泄露扫描 |

**第 1 期验收**：真实应用 E2E（Electron 与 Go 各一套）——对话里说「每天 9 点…」→ 授权卡片 → 创建 → 到点执行 →
结果投递 → 重启后状态正确；旧提醒、旧定时任务迁移后照常触发；用本机 `gh` 登录添加 GitHub 连接后，「每天 9 点看 X 仓库 CI」能跑通。

## 4. 第 2 期：编程助手执行 + 写入 + 审核闸门

| #    | 工作包                                         | 要点                                                                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | 从 `DelegateService` 抽执行层                  | 把建标签、worktree、审批、汇报解析抽成与任务无关的执行器；前台同步委派（`background:false`）行为不变                                                                                                                                                                   |
| 2.2  | 后台委派 = 任务                                | `delegate_to_cli` 后台模式创建任务（`executor: cli`）；`taskId` 是身份，标签是 `Attempt.carrier`                                                                                                                                                                       |
| 2.2b | Nomi 打底 + 按场景调用已配置的编程助手（新增） | Nomi 执行者具备全部能力（L2 在 worktree 改代码、L3 跑命令，用自己的工具）；场景优先列表（类型默认 → 编程默认 → Nomi 兜底）；授权 `clis`；可用性 = 已安装 + 已登录或配了供应商（内置）/ 已添加且启动检查通过（ACP 外部 CLI）；钉住的不可用 → 问用户；顺延的如实写进结果 |
| 2.3  | 排队代替拒绝                                   | `DelegateService.ts:903` 改为 `queued`；首次、重试、恢复、followup 共用并发名额                                                                                                                                                                                        |
| 2.4  | `delegate_stop`（补充）                        | Nomi 工具，内部 `tasks.cancel`；Node `tools()` + Go `delegateToolNames` 同步                                                                                                                                                                                           |
| 2.5  | 审核闸门                                       | 执行结束进 `awaiting_accept`，不再自动 `applyWorktreeToMain`；验收卡片（Diff、命令、检查结果）+ `tasks.applyWorktree`（dangerous）                                                                                                                                     |
| 2.6  | L2 / L3 授权 + 后台审批                        | §8.4 规则表；`waiting_user` 往返（`tasks.decide`）；授权撤销检查点（§8.6 八处）                                                                                                                                                                                        |
| 2.7  | 代次与竞态                                     | 晚到结果 / 审批 / 回填按 `gen` 丢弃；接管 → `taken_over` → `waiting_user`                                                                                                                                                                                              |
| 2.8  | 错误码 + 重试 + 续跑（补充）                   | `DelegateErrorCode` 枚举；瞬时错误重试一次；重启后同一 worktree 续跑（替代 `delegate_interrupted_by_restart`）                                                                                                                                                         |
| 2.9  | 配置变化                                       | 供应商删除、Key 更换、账号切换 → 本次失败并提示，不悄悄换配置                                                                                                                                                                                                          |
| 2.10 | 连接 C2（新增）                                | 任务编程助手默认看不到 `gh` 登录（空 `GH_CONFIG_DIR`、去掉 `GH_TOKEN` 等）；`commandReview` 加 `gh` 子命令与 `git push` 分类；Node / Go parity                                                                                                                         |

**第 2 期验收**：E2E——派一个后台编程任务 → 应用重启 → 同一 worktree 续跑 → 中风险命令（读过外部内容）暂停进收件箱 →
批准 → 完成进验收 → 查看 Diff → 回填。竞态用例：取消后审批到达、旧执行完成、来源对话删除后结果晚到。

## 5. 第 3、4 期与其他（第 1、2 期之后）

| 期 / 项         | 内容                                                                                             | 来源                  |
| --------------- | ------------------------------------------------------------------------------------------------ | --------------------- |
| 第 3 期         | 事件源 `app` / `folder` / `web` / `github`；`observe` 默认；去重、冷却                           | 设计稿 §6 + 分析 P1-1 |
| 第 3 期补充     | 语义过滤（用户写的自然语言规则，由便宜模型判断）                                                 | 分析 P1-1 Slow Path   |
| 第 4 期         | L4 对外副作用、intent/done、`needs_reconcile`；`mcp` 事件源                                      | 设计稿 §10、§16       |
| 连接 C3         | GitHub `comment` / `pr.create`；本机 MCP 服务器作为连接、工具归类（只接不做；远程 MCP 先不考虑） | connections.md §10    |
| 连接 C4（搁置） | computer use：原生辅助程序、`ComputerPort`、`app.observe` → `app.control`；只在对话与手动任务里  | connections.md §5     |
| Watchdog        | 定时检查运行中的执行：无进展、循环、偏离目标；处置 = 提醒 / followup / stop                      | 分析 P1-2             |
| 强制委派        | 依据第 0 步基线数据决定是否加 routingPolicy                                                      | 分析 P0-2             |
| IM 信道         | Outbox 新增 IM 目标；远程不允许批准授权类操作                                                    | 分析 P1-5             |
| 不做            | 云端 Agent Loop、常驻服务、DAG 编排、团队功能                                                    | 设计稿 §1、分析 §15   |

## 6. 顺序与依赖

```
第0步 → 1.1 状态机 → 1.2 存储 → 1.3 运行时 ─┬→ 1.4 迁移
                                            ├→ 1.5 契约 → 1.11 视图
                                            ├→ 1.6 Nomi 执行 → 1.7 用量 → 1.8 授权卡片 / 1.9 recall
                                            ├→ 1.10 Outbox → 1.12 重启核对
                                            └→ 1.13 连接 C1（与 1.6 汇合：github.read 工具）
第1期验收 → 2.1 抽执行层 → 2.2/2.3/2.4 → 2.5 审核闸门 → 2.6 授权审批 → 2.7/2.8/2.9/2.10 → 第2期验收
```

- 1.1、1.2 是一切的地基，先做透（含 parity golden），后面才敢并行。
- 每个工作包一个或几个提交（Conventional Commits），用户可见改动加 changeset；Node 与 Go 同一提交序列里完成，
  不出现一边有一边没有的中间版本（某版本暂缺的能力在界面上禁用并说明）。

## 7. 风险与对策

| 风险                          | 对策                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| 双版本工作量翻倍              | 状态机纯函数 + golden；执行者复用现有模块；Go 跟随同一用例集        |
| 迁移把用户提醒弄丢            | 旧文件备份一个版本；迁移幂等；迁移前后 parity 用例                  |
| 抽 `DelegateService` 引入回归 | 2.1 只搬不改，跑现有委派单测与 `delegate_parity_test.go` 全绿再继续 |
| 后台消耗                      | 预算默认保守；超额暂停等人；用量页按任务可见                        |
| 复用 `gh` 令牌权限过宽        | 展示 scopes、Broker 只发授权内请求、任务子进程隔离，三层缺一不上线  |
| 范围膨胀                      | 新需求先套「现有触发器 + 执行者」；套不进的放 §5 待议               |
