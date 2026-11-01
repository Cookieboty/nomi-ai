# 连接：让 Nomi 用上本机已有的账号与软件（设计稿）

> 状态：**已评审**；C1–C3 进入 2.1.0，**computer use（§5、C4）搁置**；起草 2026-11-01。
> 相关：[参考与取舍](persistent-tasks-references.md)（§2.13 GitHub、§2.14 MCP）、[持续任务](persistent-tasks.md)（授权 §8、事件源 §6、副作用 §10）、[密钥不出本机](secret-privacy.md)、
> [自动化与桌面能力](../features/automation.md)、[MCP 与技能](../features/mcp-skills.md)、
> [内核宿主分离](core-host-decoupling.md)（宿主端口）。

## 0. 一句话

**凭据留在原处，Nomi 只拿到「能做什么」。** 连接（Connection）是 Nomi 能用的一个外部账号或一个本机软件；
授权写明可以通过哪个连接做哪些事。模型和执行者只调用能力，看不到令牌本身，也不能越过授权直接用凭据。

## 1. 背景

- 持续任务要观察 GitHub（事件源）、在 GitHub 上留评论（L4 对外动作）；用户希望直接复用本机 `gh` 的登录。
- 之后还要做 **computer use**（看屏幕、点鼠标、敲键盘去操作没有接口的软件），以及接入邮件、日历、飞书、
  Notion 等其他软件。
- 这三件事是同一个问题：**Nomi 代表用户使用一个外部身份或一个本机软件**。分开做就会有三套凭据存放、三套授权、
  三套审计。本稿统一成「连接」。

现状（2.0.9 代码事实）：

| 现有机制             | 位置                                                      | 与本稿的关系                                                      |
| -------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| 密钥存储             | `core/src/security/secretStorage.ts`（系统钥匙串）        | 连接的令牌存这里，连接记录里只存引用                              |
| 出站检查             | `security/netGuard.ts`                                    | 连接的所有 HTTP 请求都走它                                        |
| MCP 服务器与信任级别 | `extensions/mcpConfig.ts`（`ask` / `read-auto` / `auto`） | 每个 MCP 服务器就是一个连接；后台任务不继承前台信任级别           |
| 文件拒绝名单         | `desktop/pathGuard.ts`                                    | computer use 的「始终拒绝的应用」照这个做                         |
| 云端发送确认         | `desktop/outboundGuard.ts`、`PermissionBroker`            | 截图发给云端模型前走同一套「仅本地 / 云端首次发送」               |
| 命令自动审核         | `desktop/commandReview.ts`                                | 新增 `gh` 子命令的分类（§4.4）                                    |
| 受控浏览器           | 自动化：不保存 cookie、不共享登录                         | 保持不变：**不**把浏览器登录态做成连接（§8）                      |
| 屏幕截图             | `screen/ScreenService.ts`：截图与屏幕记忆已在 2.0.4 移除  | computer use 重新引入截图，范围只限授权的应用窗口，不留存（§5.4） |

## 2. 模型

```ts
interface Connection {
  id: string; // conn_<uuid>
  provider: 'github' | 'mcp' | 'app' | 'web'; // 以后可加 'feishu' | 'mail' …
  label: string; // 用户可读：「GitHub · cookieboty」「Mail.app」
  auth: AuthRef;
  account?: { login: string; host: string }; // 只用于展示和变更检测（§4.3）
  observedScopes?: string[]; // 实际拿到的权限范围，例如 gh 令牌的 scopes
  status: 'ok' | 'needs_login' | 'error' | 'disabled';
  checkedAt?: number;
  createdAt: number;
  schemaVersion: 1;
}

type AuthRef =
  | { kind: 'cli-login'; cli: 'gh'; host: string } // 复用本机 CLI 的登录，凭据留在 CLI 自己的存储里
  | { kind: 'keychain'; secretRef: string } // 用户粘贴的令牌，存系统钥匙串
  | { kind: 'mcp'; serverId: string } // MCP 服务器自己管理凭据
  | { kind: 'none' }; // 本机应用（computer use）、公开网页

/** 授权里引用连接的方式（持续任务 §8 的 Grant 增加这一项） */
interface ConnectionGrant {
  connectionId: string;
  capabilities: string[]; // 例：['github.read', 'github.comment']
  resources: string[]; // 例：['owner/repo']、['com.apple.mail']；空 = 不允许任何资源
}
```

每种连接声明自己的**能力目录**，每项能力带副作用范围（与持续任务 §10.1 同一套 `none` / `local` / `external`）
和最低授权等级：

| 能力                       | 副作用     | 等级  | 说明                                                      |
| -------------------------- | ---------- | ----- | --------------------------------------------------------- |
| `github.read`              | `none`     | L1    | issue、PR、评论、CI 状态、通知                            |
| `github.comment`           | `external` | L4    | 在授权仓库的 issue / PR 下评论                            |
| `github.pr.create`         | `external` | L4    | 推分支、开 PR（推到 `nomi/` 前缀的分支）                  |
| `github.merge` / `release` | —          | 永不  | 与持续任务 §8.2 一致                                      |
| `mcp.<server>.<tool>`      | 按工具标注 | L1/L4 | 默认 `external`，`readOnlyHint` 或用户标为只读才算 `none` |
| `app.observe`              | `none`     | L1    | 截取授权应用的窗口                                        |
| `app.control`              | `external` | L4    | 在授权应用里点击、输入                                    |
| `web.read`                 | `none`     | L1    | 公开网页、RSS（持续任务 `web` 事件源）                    |

规则：

- 能力只能在授权里**逐项**给出，`resources` 必须写明（哪个仓库、哪个应用），没有通配。
- 前台对话里使用连接沿用现有的确认规则；后台任务只认任务授权（持续任务 §8.1）。
- 撤销或删除连接 → 引用它的所有授权失效 → 相关任务进 `waiting_user`（重新授权）。

## 3. 用凭据而不接触凭据

所有经连接的调用都在内核的**连接适配器**里完成，不把凭据交给模型、执行者或子进程：

```
模型 / 任务执行者 ──能力调用(github.read, owner/repo, 参数)──▶ ConnectionBroker
                                                              │ 1. 查授权：能力 ∈ 授权、资源 ∈ resources
                                                              │ 2. 撤销检查点（持续任务 §8.6）
                                                              │ 3. external 能力：先写 intent（§10.2）
                                                              ▼
                                       适配器（github / mcp / app / web）
                                       ├─ cli-login：内核拼好固定 argv 调 gh（§4.2）
                                       ├─ keychain：内核取密钥，加 Authorization 头，经 netGuard 发出
                                       ├─ mcp：经 ExtensionsService 调用
                                       └─ app：经宿主端口 ComputerPort（§5）
                                                              │
                                                              ▼
                                       结果标为外部内容（markExternalRead）后返回
```

- 密钥原文只在适配器调用的那一刻存在于内核进程内存；不进任务文件、提示词、轨迹、审计日志。
- 结果里万一带回令牌（如某接口回显），照常经网关的密钥脱敏（[secret-privacy](secret-privacy.md)）。
- 审计：每次能力调用记一条（连接 id、能力、资源、参数哈希、结果状态），与现有审计日志同格式。

## 4. GitHub 连接

### 4.1 两种登录方式（解决持续任务 §18-2）

**允许复用本机 `gh` 登录。** 添加 GitHub 连接时：

| 方式               | 默认                     | 说明                                                                                                                        |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 使用本机 `gh` 登录 | 检测到已登录时为默认选项 | 凭据留在 `gh` 自己的存储里；Nomi 不读取令牌（不调用 `gh auth token`）                                                       |
| 粘贴令牌           | 未检测到 `gh` 时为默认   | 只观察指定仓库：细粒度只读令牌即可；要用**通知**：GitHub 的通知接口只支持经典令牌（需 `notifications` 或 `repo`）；存钥匙串 |

复用 `gh` 的代价是令牌权限通常很宽，对策分三层：

1. **如实展示**：添加时用 `gh auth status --json hosts --hostname <host> --no-refresh` 读出账号、scopes、令牌来源（输出不含令牌，`--no-refresh` 避免检测时改动用户的登录）；含 `repo`、`workflow`、
   `delete_repo`、`admin:*` 等宽权限时，在卡片上写明「这个登录能做的远多于你要授权的」，并给出改用细粒度令牌的入口。
2. **Nomi 自己收窄**：能做什么由 Nomi 的授权决定，不由令牌决定。适配器只发授权内能力对应的请求（§4.2），
   仓库不在 `resources` 里直接拒绝。
3. **子进程看不到**：任务里的编程助手默认**看不到** `gh` 登录（§4.4）。

### 4.2 适配器只拼固定请求

- 每项能力对应一组固定的请求模板，例如 `github.read` → `GET /repos/{owner}/{repo}/issues?since=…`，
  `github.comment` → `POST /repos/{owner}/{repo}/issues/{n}/comments`。模型给的是参数，不是 URL 或命令。
- `cli-login` 方式：`gh api --method <M> --hostname <host> <path>`，argv 逐项传、不经 shell；
  子进程环境只保留 `PATH`、`HOME`、`GH_CONFIG_DIR`（如用户设过）等必要变量。
- `keychain` 方式：内核直接 `fetch`，经 `netGuard`。
- 请求**串行**；有 `retry-after` 按它等，`x-ratelimit-remaining` 为 0 等到 `x-ratelimit-reset`，否则至少等 1 分钟再指数退避；
  写请求之间至少间隔 1 秒。轮询带 ETag / `If-Modified-Since`（带认证头时 304 不计入额度），通知接口遵守 `X-Poll-Interval`。
- 支持 GitHub Enterprise：`host` 不写死。

### 4.3 账号与权限变化

执行快照记 `account.login` 与 `observedScopes`（持续任务 §8.7）。每次执行前用 `gh auth status` 复核
（有缓存，几分钟一次）：账号换了、登出了、scopes 变化 → 本次执行失败并提示，连接变 `needs_login`，
用户确认后再继续，不悄悄换成另一个账号。

### 4.4 编程助手任务里的 `gh`

编程助手（Codex、Claude Code……）在 worktree 里自己会跑 `gh`、`git push`，这些调用不经过适配器。规则：

- **默认隔离**：任务的编程助手子进程设 `GH_CONFIG_DIR` 为一个空的临时目录、`GH_PROMPT_DISABLED=1`，并去掉 `GH_TOKEN`、
  `GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`（`gh` 里环境变量优先于已存的登录）；它看不到用户的
  `gh` 登录。任务授权里有 GitHub 连接的对外能力时才不隔离。
- **这只是默认值，不是安全边界**：编程助手仍可能用别的办法读到系统凭据库里的令牌。真正的边界是命令审核——
  `gh auth token`、`gh auth status --show-token`、读系统凭据库的命令（如 macOS `security find-generic-password`）
  在后台任务里一律暂停等人。
- **命令分类**：`commandReview` 增加 `gh` 子命令分类——`gh issue view` / `pr view` / `run view` / `api`（GET）
  为只读；`gh issue comment`、`pr create`、`api -X POST|PATCH|PUT|DELETE` 为 `external:github.*`，需要授权里有
  对应能力，否则暂停；`gh pr merge`、`release create`、`repo delete` 永远暂停等人。`git push` 同样按 `external` 处理。
- 前台（工作台里用户自己开的编程助手会话）行为不变。

## 5. Computer use

### 5.1 是什么

Nomi 截取某个应用的窗口、理解画面、点击和输入，去操作**没有接口**的软件。它是最后手段：
能用 API、MCP 或命令完成的事，不用 computer use（§6）。

### 5.2 宿主端口

平台能力经宿主端口（[内核宿主分离](core-host-decoupling.md) §6），内核不直接调系统接口：

```ts
interface ComputerPort {
  available(): { ok: boolean; missing?: ('accessibility' | 'screen-recording')[]; reason?: string };
  listApps(): Promise<{ appId: string; name: string; running: boolean }[]>; // appId：macOS bundle id / Windows AUMID 或 exe
  frontmost(): Promise<{ appId: string; windowId: string; secureField: boolean } | null>;
  capture(windowId: string, opts: { maxEdge: number }): Promise<Png>; // 只截这一个窗口
  act(windowId: string, action: ComputerAction): Promise<void>; // click / type / key / scroll / drag
}
```

- macOS：辅助功能 + 屏幕录制权限；按窗口截图，不截整个桌面。Windows：UI Automation + 窗口截图。
  Linux：X11 先不做，Wayland 不支持；不支持时界面明确禁用并说明（不静默降级）。
- **实现只写一份**：做一个小的原生辅助程序（stdio JSON 协议），Electron 版与 Go 版都调用它，避免两套原生实现。
  依赖只用开源许可（`pnpm check:licenses`），登记 `CREDITS.md`。

### 5.3 安全规则

| 规则             | 说明                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 按应用授权       | 连接 = 一个应用（`provider: 'app'`）；授权的 `resources` 是 appId。只截、只操作授权应用的窗口                          |
| 每步复核前台窗口 | 每次 `act` 前查 `frontmost()`：不是授权应用 → 不执行，暂停                                                             |
| 始终拒绝的应用   | 密码管理器、钥匙串访问、系统设置的安全与隐私、终端类应用（用命令工具代替）、Nomi 自身；与 `pathGuard` 一样内置、不可关 |
| 密码框不输入     | 焦点在安全输入框（macOS `AXSecureTextField`、Windows `IsPassword`）→ 拒绝输入并暂停                                    |
| 永不做           | 输入密码或支付信息、同意系统权限弹窗、修改安全设置                                                                     |
| 用户在场即让位   | 检测到用户动了鼠标或键盘 → 立即暂停，等同接管（持续任务 §5.3 `taken_over`）                                            |
| 可见、可停       | 角色和灵动岛显示「正在操作 <应用>」；全局快捷键随时停止                                                                |
| 画面是外部内容   | 截图一律 `markExternalRead`；画面里的文字不能授予权限（同持续任务 §8.1）                                               |
| 截图外发         | 发给云端模型前走 `outboundGuard` 的云端首次发送确认；「仅本地模型」设置下只能用本地视觉模型                            |
| 副作用           | `app.control` 默认 `external`；重启后一律 `needs_reconcile`（无法自动核对点过什么）                                    |

### 5.4 截图留存

截图只在内存里用于本次模型调用；执行轨迹里只存缩小的缩略图（默认关闭，可在任务里打开），随轨迹一起按保留期删除。

### 5.5 后台任务里的 computer use

computer use 要占用用户的屏幕和输入，与「后台」天然冲突。第一版规则：

- 对话里（用户在场）可以用；任务里只允许**手动触发**（`runNow`）的执行使用 `app.*` 能力。
- 定时和事件触发的任务不能获得 `app.control`；以后若要做，条件是「用户离开电脑超过 N 分钟」且锁屏不可用时不执行，另行评审。

## 6. 接入其他软件：按风险选路径

同一件事有多条路时，Nomi 按下面的顺序选，授权卡片上写明走的是哪条：

1. **官方 API 的内置适配器**（目前只有 GitHub）——能力最清楚、最容易收窄。
2. **MCP 服务器**（用户装的邮件、日历、飞书、Notion……）——每个服务器是一个连接，工具逐个归类（§2 能力表）。
3. **本机命令行工具**（`gh` 之外的 CLI）——经命令自动审核；不新增连接类型。
4. **computer use**——只在前三条都没有时使用。

MCP 连接的补充：

- 后台任务不继承 MCP 服务器的前台信任级别（即使是 `auto`），只认任务授权。
- **Nomi 只接 MCP，不做 MCP**：只作为客户端使用用户已经配好的 MCP 服务器，不提供 MCP 服务器。
- **远程 MCP 先不考虑**：连接只接本机（stdio）MCP 服务器，凭据由服务器自己从环境变量取（MCP 规范对 stdio 的要求）；
  需要网页登录（OAuth）的远程服务器不在 2.1.0 范围内。

## 7. 界面与契约

- **设置 → 外部连接**（实现时与「连接」这个动词区分开）：列出所有连接（账号、状态、权限范围提示、被哪些任务使用）；添加、重新检测、停用、删除。
  删除前用 `confirmDialog` 列出受影响的任务。
- 授权卡片（持续任务 §12）按连接分组显示要给的能力与资源。

契约域 `connections`（`packages/contract/src/app/connections.ts`，处理函数 `core/src/contract/connections.ts`，
Go `internal/core/connectionshandlers`）：

| 过程                                         | 说明                                   | dangerous |
| -------------------------------------------- | -------------------------------------- | --------- |
| `connections.list` / `connections.get`       | 列表 / 详情（不含任何密钥）            | 否        |
| `connections.detect`                         | 检测本机可复用的登录（`gh`）与可用应用 | 否        |
| `connections.add`                            | 添加（复用 `gh`、粘贴令牌、选择应用）  | **是**    |
| `connections.check`                          | 重新检测账号与权限                     | 否        |
| `connections.disable` / `connections.remove` | 停用 / 删除（连带授权失效）            | 否        |
| 事件 `connections.changed`                   | 状态变化（`eventSurfaces: chat`）      | —         |

## 8. 不做的事

- 不读取、不导出其他软件保存的凭据（不调 `gh auth token`、不读浏览器 cookie、不读钥匙串里别的条目）。
- 受控浏览器保持「不保存 cookie、不共享登录」；网页登录态不做成连接。
- 不做远程（手机 / IM）批准授权类操作。
- 不做 MCP 服务器；不接远程 MCP（及其 OAuth 登录）；不自建 OAuth 应用托管服务。

## 9. 模块位置

| 部分               | Node（`internal/core/src`）                     | Go（`internal/core`）                |
| ------------------ | ----------------------------------------------- | ------------------------------------ |
| 连接存储与能力目录 | `connections/ConnectionStore.ts`、`catalog.ts`  | `connections/store.go`、`catalog.go` |
| 代理调用与授权检查 | `connections/ConnectionBroker.ts`               | `connections/broker.go`              |
| GitHub 适配器      | `connections/github/*`                          | `connections/github/*`               |
| `gh` 命令分类      | `desktop/commandReview.ts`                      | `desktop` 对应文件                   |
| computer 宿主端口  | `host-ports`：`ComputerPort`；Electron 宿主实现 | Wails 宿主实现                       |
| 原生辅助程序       | 单独目录，两版共用（位置待定）                  | 同                                   |

存储：`userData/connections.json`（`privateFile` 原子写，不含密钥）；密钥在钥匙串。Node 与 Go 同一格式，
Go 版迁移时一并迁移。

## 10. 分期

| 期  | 内容                                                                                                | 版本     |
| --- | --------------------------------------------------------------------------------------------------- | -------- |
| C1  | 连接模型、存储、能力目录、Broker、设置页、契约；GitHub 连接（`gh` 登录 + 令牌，`github.read`）      | 2.1.0 ✅ |
| C2  | 编程助手任务的 `gh` 隔离与 `gh` 命令分类（随持续任务第 2 期）                                       | 2.1.0    |
| C3  | GitHub 对外能力（`comment`、`pr.create`）+ intent/done（随持续任务第 4 期）；MCP 连接与工具归类     | 2.1.x    |
| C4  | computer use：原生辅助程序、`ComputerPort`、`app.observe`，之后 `app.control`；只在对话与手动任务里 | 搁置     |

2.1.0 先把**模型、授权格式、能力目录**定下来，C4 的类型与安全规则在 2.1.0 的能力目录里预留，避免以后改授权格式。

## 11. 测试

| 层           | 内容                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| Broker 单测  | 能力不在授权内、资源不在列表内、撤销后调用、`external` 先写 intent                      |
| GitHub       | 模拟 `gh`（假可执行文件）与模拟 API：scopes 解析、账号切换、登出、限流、ETag、GHES host |
| 隔离         | 任务编程助手子进程里 `gh auth status` 应显示未登录；环境变量里没有 `GH_TOKEN` 等        |
| 命令分类     | `gh` 子命令表逐条；`gh api` 各种 `--method` / `-X` 写法；`git push`                     |
| 泄露         | 任务文件、轨迹、审计日志、提示词里搜不到令牌（注入已知假令牌后全文扫描）                |
| parity       | 能力目录、授权检查结果、`gh` 命令分类 Node / Go 逐条比对                                |
| computer use | 前台窗口不是授权应用时拒绝；安全输入框拒绝；用户输入即暂停；拒绝名单（C4）              |

## 12. 待决定

1. 原生辅助程序用什么写、放在哪（Go 写并随两版分发，体积可控；还是各自实现）。（computer use 搁置，C4 前再定）
2. 「始终拒绝的应用」初始名单（按 bundle id / exe 维护，随版本更新）。
3. 复用 `gh` 时，宽权限警告是否要求用户额外勾选「我了解」才能添加。
4. 无人值守的 computer use 是否永远不做。

## 13. 风险

- **令牌权限过宽**：复用 `gh` 方便但危险。三层收窄（展示、适配器只发授权内请求、子进程隔离）是底线，缺一层不上线。
- **屏幕即攻击面**：网页、邮件里的文字可以伪装成指令。截图一律算外部内容，`app.control` 一律算对外动作。
- **误操作**：点错按钮无法撤销。只在授权应用里、每步复核前台窗口、用户一动就停。
- **双版本**：原生部分只写一份辅助程序；Broker 与分类规则用 parity 守住。
