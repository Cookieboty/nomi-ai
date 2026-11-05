# 安全边界

用户能看到的说明见 [features/privacy-security.md](../features/privacy-security.md)；本页列实现位置，改这些代码前先看这里。

## 视图 ⇄ 内核

- 视图只经契约访问内核（[contract.md](contract.md)）：每个窗口一个一次性 token，内核按 token 认出调用方界面；过程的 `surfaces` /
  `dangerous` 由 `internal/contract/frames.go` 的守卫判定。WebSocket 只监听 `127.0.0.1`。
- 拖入文件的本机路径由宿主从原生拖放事件里拿（`wailsshell` 的 WindowFilesDropped），视图交不出任意路径。
- 视图带来的目录（标签 cwd、Nomi 对话工作区）内核要再校验，不认就按没有处理。

## 桌面能力（Nomi 的文件 / 命令工具）

`apps/desktop-go/internal/core/desktop`：

| 文件                                 | 作用                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `path_guard.go`                      | 授权作用域 + 黑名单 + 路径规范化 + realpath 防符号链接逃逸                                                        |
| `workspace.go`                       | 对话工作区作为隐式读写作用域；拒绝过宽的根（家目录、盘符根等）                                                    |
| `permission_broker.go`、`consent.go` | 授权作用域、工具策略、确认请求、云端外发同意；何时需要用户确认                                                    |
| `command_class.go`                   | 命令的确定性分类（读凭据、不可逆操作、对外副作用）                                                                |
| `command_review.go`                  | `workspace_run` 的命令先交辅助模型判风险：低风险放行，拿不准 / 高风险交给人确认（卡片带等级与理由）；不替用户拒绝 |
| `outbound_guard.go`                  | 发给云端模型前，按设置挡下或替换附件正文与编程助手输出                                                            |
| `audit_log.go`                       | 桌面工具调用审计（`desktop-YYYY-MM.jsonl`，参数脱敏）                                                             |
| `undo_journal.go`                    | 可撤销操作的逆操作日志                                                                                            |

## 代码执行沙箱

`apps/desktop-go/internal/core/sandbox`：

| 语言 / 平台      | 隔离                                                                     | 回落                             |
| ---------------- | ------------------------------------------------------------------------ | -------------------------------- |
| JavaScript       | 本机 `node --permission`，只能读写临时目录，禁止由字符串生成代码，限内存 | —                                |
| Python · macOS   | `sandbox-exec` + 内置 Seatbelt 配置（只写临时目录，默认禁网）            | 找不到二进制 → 裸 `python -I`    |
| Python · Linux   | `bwrap`（只读系统目录、可写临时目录、`--unshare-net`）                   | 没装 bubblewrap → 裸 `python -I` |
| Python · Windows | 无文件系统隔离                                                           | —                                |

结果里的 `sandbox` 字段说明实际用了哪种隔离，界面据此提示；没有隔离时确认更严格。

## 委派的工作目录

Nomi 用 `delegate_to_cli`（或持续任务的编程助手执行）把任务交给编程助手时（`internal/core/cli/delegate/`）：

1. 默认直接在工作目录里改（`in-place`），不开 worktree。同一个 git 仓库里并行的任务按文件登记谁在改
   （`claims.go`，来自编程助手改文件类工具事件的入参）；两个任务改到同一个文件时按优先级裁决
   （urgent > high > medium > low，同级先来的优先），让路的一方收到插话，别再动这个文件；收尾时这个文件算赢的一方的，
   同期别的任务改的文件也不算进自己的改动。跑命令改的文件认不出来，按 git 列出且没人登记的仍算自己的。
2. 只有明确指定了别的分支做基线（`base_branch`），且那个分支不在当前分支的历史里时，才在 `<cwd>/.nomi-delegate/<id>`
   从它建 detached 的 worktree（`.nomi-delegate/` 写进仓库的 `info/exclude`）。
3. worktree 做完落地（`LandWorktree`）：改动少（≤ 10 个文件且 ≤ 400 行）拷回当前工作区，目标文件已有改动或在授权外的不覆盖；
   改动多、以及拷不回去的文件提交到新分支 `nomi/<基线>-<id>`（不跑钩子、不签名），由用户决定是否合并。落地后拆掉 worktree。
   同步委派做完就落地；持续任务在验收卡片上「落地改动」，或验收通过时自动落地。
4. 取消、失败放弃、过期、删除任务时拆掉 worktree（用户接手的标签除外）；应用启动时清理没人认领的委派 worktree，
   有改动的先提交到新分支再拆。
5. 非 git 目录在原目录运行，并在结果里提示并行任务会互相改文件。
6. 同时运行的委派最多 3 个（`MaxParallelDelegates`）。

编程助手自带的沙箱（如 Codex 的 Seatbelt）照常生效；这一层只解决并行写同一工作树。

委派出去的编程助手标签只在 Nomi 里看（对话里的子任务卡片、任务页）：不进侧栏，委派用过的会话不出现在编程助手的历史里
（`harness/orchestrator_delegated.go`）。同一个对话里同一种委派（编程助手、目录、任务类型、模型、思考深度都相同）
接着用上一次空闲的会话（一小时内用过的，`reuse.go`），省 token 也更快；在 worktree 里做的不复用。
委派标签闲置超过一周、对应任务已结束的，应用启动时关掉（用户在侧栏关不到它们）。

## 网络

- 出站 URL 只允许公网 http(s)，拒绝内嵌凭据与保留地址（`internal/core/security/netguard.go`）；网关出站另有地址分类与 DNS 钉 IP
  （`internal/gateway/net`），防解析后被重绑定到内网。
- 网关、契约服务都只监听回环地址，并校验 `Host` 头。

## 密钥与隐私

- API Key 等机密：系统钥匙串里存一把主密钥，磁盘上存加密后的 `enc:` 值（`internal/core/security/secretbox.go`）；钥匙串不可用时失败关闭，不落明文。
- 隐私模式：网关发给上游前把密钥、令牌等敏感串换成占位符，响应回来再换回（`internal/gateway/privacy`）。
- 诊断日志与审计记录写入前脱敏（`internal/core/services/redact.go`、`audit_log.go`）。
