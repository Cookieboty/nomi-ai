# 编程助手官方账号：多账号登录与全局切换 + Gemini CLI 接入（设计稿）

> 状态：设计稿 + 分阶段实现（第 9 节进度）。
> 查证 2026-10-19：Claude Code 2.1.303、Codex CLI 0.163.0、Grok Build 1.0.62（本机二进制 / 非交互登录实测）、
> Gemini CLI 0.62.0（隔离目录安装实测 + 源码）；cc-switch 4.0.15（main@adc223a 源码与 issue）。
> 平台：macOS / Linux / Windows（第 7 节）。
> 相关：[权限模式](cli-permission-modes.md)、[子代理](cli-subagents.md)、[编程助手接入](../features/coding-agent-harness.md)。

## 1. 目标

1. 在 App 里为 Claude Code、Codex、Grok、Gemini 各登录**多个官方账号**（订阅 / Google 登录），随时切换。
2. 切换是**全局**的（与 cc-switch 一致）：改写 CLI 自己的凭据存储，用户在终端里直接运行的 CLI 也跟着切。
3. 登录走**官方 CLI 自己的登录流程**（Nomi 不实现 OAuth、不经手密码）。
4. **Gemini CLI 接入成第 5 个编程助手后端**（检测 / 安装 / 更新、对话、权限模式、子代理、历史、用量、监视）。

## 2. cc-switch 的做法与我们要避开的坑

|                   | cc-switch 4.0.15                                                                                                                                                | Nomi                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Claude 多官方账号 | **不支持**（维护者明确表态，#1859 / #4850：多张官方卡切换后 `claude auth status` 仍是最后登录的那个，因为凭据与 `oauthAccount` 都不替换）                       | 支持：替换钥匙串 / `.credentials.json` 中的 `claudeAiOauth` 并同步 `~/.claude.json` 的 `oauthAccount` |
| Codex             | 自己实现 Device Code OAuth（复用官方 client_id），或「登录暂存」；全局改写 `~/.codex/auth.json`；切走前把 CLI 轮换后的 refresh_token 收回（判断不出新旧就取消） | 用官方 `codex login --device-auth` 登录；切换同样改写 `auth.json` 并先回收                            |
| Grok / Gemini     | 不支持官方多账号（Grok 多账号 PR #6771 未合入）                                                                                                                 | 支持                                                                                                  |
| 凭据落盘          | 明文 SQLite / JSON（#1108 要求加密未做）                                                                                                                        | `safeStorage` 加密，失败关闭                                                                          |
| 已知问题          | 快照过期（#7105）、`auth.json` 误删 / 没还原导致 401（#6925、#8390）、keyring 模式切不动（#3479、#8143）                                                        | 每次写之前备份；回收失败不覆盖；keyring 模式先提示改成文件存储                                        |

## 3. 各 CLI 的凭据（实测 / 源码）

| CLI    | 全局凭据位置                                                                                                                                                                                                                                      | 内容 / 身份                                                                                                                                                                                                                                   | 刷新行为                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Claude | macOS：钥匙串 generic password，service `Claude Code-credentials`（设了 `CLAUDE_CONFIG_DIR` 时追加 `-<sha256(目录) 前 8 位>`），account `$USER`，由 CLI 调 `security` 读写；Linux / Windows：`<CLAUDE_CONFIG_DIR 或 ~/.claude>/.credentials.json` | JSON 的 `claudeAiOauth`（accessToken / refreshToken / expiresAt / scopes / subscriptionType / rateLimitTier）；身份在 `~/.claude.json`（或 `$CLAUDE_CONFIG_DIR/.claude.json`）的 `oauthAccount`（accountUuid / emailAddress / organization…） | CLI 刷新后 CAS 写回同一位置           |
| Codex  | `$CODEX_HOME 或 ~/.codex/auth.json`（默认 `cli_auth_credentials_store = "file"`；`keyring` / `auto` 时在系统钥匙串 `Codex Auth`）                                                                                                                 | `tokens.{id_token, access_token, refresh_token, account_id}`、`last_refresh`；身份取 id_token 的 email + account_id（workspace）                                                                                                              | CLI 刷新后重写 `auth.json`            |
| Grok   | `$GROK_HOME 或 ~/.grok/auth.json`（文件；刷新用 `auth.json.lock` 互斥）                                                                                                                                                                           | OAuth token；身份由 `grok` 的登录状态（ACP）给出                                                                                                                                                                                              | CLI 刷新后重写，持锁                  |
| Gemini | `$GEMINI_CLI_HOME 或 ~/.gemini/oauth_creds.json`（0600 明文；`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` 时改为钥匙串 / 加密文件）+ `google_accounts.json`（`{active, old[]}`）                                                                    | google-auth-library Credentials（access_token / refresh_token / id_token / expiry_date）；身份取 `google_accounts.json.active` 或 id_token email                                                                                              | CLI 刷新后合并重写 `oauth_creds.json` |

## 4. 非交互登录（实测）

都在 **暂存目录**（隔离的 CLI 配置目录）里跑官方登录命令，登录成功后把凭据收进 Nomi 保险箱，暂存目录（及 macOS 上暂存的钥匙串条目）随即删除。**用户现有的全局登录在登录过程中不受影响。**

| CLI    | 命令（env）                                                                           | CLI 输出 → 界面                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude | `CLAUDE_CONFIG_DIR=<暂存> claude auth login --claudeai`                               | 打开浏览器 + 打印授权 URL；回调失败时提示 `Paste code here if prompted >` → 界面给「粘贴授权码」输入框，写回 stdin              |
| Codex  | `CODEX_HOME=<暂存> codex login --device-auth -c cli_auth_credentials_store="file"`    | 打印 `https://auth.openai.com/codex/device` 与一次性码（15 分钟）                                                               |
| Grok   | `GROK_HOME=<暂存> grok login --device-auth`                                           | 打印 `https://accounts.x.ai/oauth2/device?...` 与确认码                                                                         |
| Gemini | `GEMINI_CLI_HOME=<暂存> gemini --acp` → `authenticate { methodId: "oauth-personal" }` | ACP 下不弹 `[Y/n]` 直接开浏览器（127.0.0.1 回调，5 分钟超时）；0.62 不把授权 URL 输出到 stdout / stderr，界面只提示去浏览器完成 |

此外支持「**导入当前登录**」：把全局位置现有的凭据存成一个账号（第一次启用时默认做一次，避免切换时丢失原登录）。

## 5. 切换（全局）

对某个 CLI 激活账号 B（当前活动为 A）：

1. **回收**：读全局凭据 L。
   - L 的身份 = A：L 比保险箱里的 A 新（refresh token 不同或 expiresAt / last_refresh 更晚）→ 更新 A；判断不出新旧 → **取消切换并提示**（不覆盖可能更新的登录）。
   - L 的身份不在保险箱里（用户在终端里另登了号）→ 自动存成新账号「终端登录 · <email>」再继续。
   - 没有 L（已登出）→ 继续。
2. **备份**：把要改的全局文件 / 钥匙串值写入 `userData/cli-accounts/backups/<时间戳>/`（加密），保留最近 10 份。
3. **写入**：原子写（临时文件 + rename，0600；Windows 用 `utils/privateFile`）；macOS Claude 用 `security add-generic-password -U -s "Claude Code-credentials" -a $USER -w`；Claude 同步 `oauthAccount`；Gemini 同步 `google_accounts.json.active`。任何一步失败 → 用第 2 步的备份还原。
4. **接管配置**：该 CLI 若启用了 Nomi 的第三方供应商档案 → 自动停用（官方登录与第三方 Key 互斥），提示一次。
5. **生效**：Claude 长驻进程按 `recycleBackend` 静默重拉；Codex / dsh / Grok / Gemini 下一轮生效。有标签正在运行时提示「切换在下一轮生效」。
6. **前置检查**：Codex 是 `keyring` / `auto` 存储 → 提示改成 `file`（经用户确认写入 `~/.codex/config.toml`）；Gemini 开了加密存储 → 暂不支持并说明；Grok 有进程持有 `auth.json.lock` → 稍后重试。

删除账号只删保险箱；若是活动账号，可选择「同时退出全局登录」（调用 CLI 自己的 logout）。

## 6. 数据与界面

- **保险箱**：`userData/cli-accounts/<kind>.json`（0600），每项 `{ id, kind, label, identity: { email?, accountId?, plan?, org? }, createdAt, lastUsedAt, credEnc }`；`credEnc` 是凭据文件内容的 JSON，经 `safeStorage` 加密，安全存储不可用时**拒绝保存**（与 #35 一致）。日志、导出、IPC 返回值里永远不含凭据。
- **IPC**（`ai:cli-account:*`，经 `guardedHandle`）：`list`、`login-start(kind)` / `login-input(id, text)` / `login-cancel(id)`（进度事件 `ai:cli-account:login`：url / code / waiting / done / error）、`import-current(kind)`、`activate(id)`、`rename`、`remove(id, { logout })`、`live(kind)`（当前全局登录的身份，用于显示「终端当前账号」）。
- **界面**：编程助手每个端点的「供应商」页顶部增加「官方账号」区：账号卡（邮箱、套餐、当前标记、最近使用）、添加账号（登录弹窗：链接 + 复制设备码 / 粘贴授权码 + 状态 + 取消）、导入当前登录、切换、重命名、删除。输入栏的端点芯片显示当前官方账号邮箱。

## 7. 跨平台

|                       | macOS                                                                                                 | Linux                            | Windows                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| Claude 凭据           | 钥匙串（`security`，与 CLI 同一工具读写，不弹额外授权）                                               | `~/.claude/.credentials.json`    | `%USERPROFILE%\.claude\.credentials.json` |
| Codex / Grok / Gemini | 文件                                                                                                  | 文件                             | 文件（`%USERPROFILE%\.codex` 等）         |
| 文件权限              | 0600                                                                                                  | 0600                             | `utils/privateFile`（当前用户 ACL）       |
| 打开浏览器            | CLI 自己打开；界面另给链接                                                                            | 同左（无图形环境时界面链接兜底） | 同左                                      |
| 进程                  | 登录进程与 harness 一样用 `spawnHarness`（Windows `.cmd` shim → node 入口），取消用 `killProcessTree` |                                  |                                           |

测试只用 `.mjs` mock CLI + 假 home 目录，三平台一致；macOS 钥匙串经可注入的 `KeychainAdapter`，单测里用内存实现。

## 8. Gemini CLI 后端

- **通道**：ACP（`gemini --acp`，stdio JSON-RPC 2.0）长驻进程，与 Claude 一样多轮复用：`initialize` → `session/new` / `session/load` → `session/prompt`；`session/update` 的 `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` 映射为 text / thinking / tool；`session/request_permission` → 权限队列（`allow_once` / `reject_once`）；`session/cancel` 中止。`-p -o stream-json`（单轮、不能审批）不作主通道。
- **启动**：spawn 的 cwd = 标签目录；`GEMINI_CLI_TRUST_WORKSPACE=true`（否则 headless 退出码 55 / 审批被强制回 default）。
- **权限模式**：plan → `plan`（headless 下 `exit_plan_mode` 会自动切 YOLO，ACP 下按审批处理）；manual → `default`（ACP 可审批）；acceptEdits → `autoEdit`；auto → `autoEdit` + policy 放行只读命令（先降级为 acceptEdits）；bypass → `yolo`。运行中切换用 `session/set_mode`。
- **子代理**：`invoke_agent { agent_name, prompt }` 归为子代理；内部步骤不进主流，P2 再 tail `~/.gemini/tmp/<项目>/chats/<父会话>/<子会话>.jsonl`。
- **检测 / 安装 / 更新**：`@google/gemini-cli`（npm / pnpm / volta / homebrew 识别），`gemini --version`。
- **供应商档案**：`GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` / `GEMINI_MODEL`；注意用户 settings 里 `security.auth.selectedType=oauth-personal` 时只设环境变量切不到 Key 模式 → 档案启用时同时写入 `security.auth.selectedType`（标记区块，可还原）。
- **历史 / 用量 / 监视**：会话 `~/.gemini/tmp/<短名>/chats/session-*.jsonl`（`projects.json` 映射项目路径），gemini 消息带 `tokens.{input,output,cached,thoughts,tool,total}`；进程名 `gemini`。

## 9. 实施阶段

| 阶段   | 内容                                                                                                                                                | 状态   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A1     | 保险箱 + 四个 CLI 的凭据适配器（读 / 写 / 身份 / 备份还原）+ 回收与切换 + 导入当前登录 + IPC                                                        | 已完成 |
| A2     | 暂存目录登录（Claude / Codex / Grok；Gemini 随 G2）+ 登录进度事件                                                                                   | 已完成 |
| A3     | 界面：官方账号区、登录弹窗、切换与删除、端点芯片显示当前账号                                                                                        | 已完成 |
| G1     | Gemini 后端：检测 / 安装 / 更新、ACP 对话、权限模式、子代理识别、端点列表与图标                                                                     | 已完成 |
| G2     | Gemini 官方登录（ACP authenticate）+ 账号切换（同时把 settings.json 的认证方式改为 `oauth-personal`）+ Gemini 端点页的官方账号区                    | 已完成 |
| G3     | Gemini 第三方供应商档案（API Key / Base URL）、输入栏端点芯片、磁盘历史 / 用量 / 监视                                                               | 待做   |
| 待实测 | 各 CLI 真实登录成功后的文件形态（本机只跑到等待授权）；Codex keyring 模式；Grok 身份字段；Gemini 浏览器打不开（Linux 无桌面）时的退路；Windows 实机 | —      |
