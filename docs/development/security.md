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

## 委派隔离

Nomi 用 `delegate_to_cli` 把任务交给编程助手时（`internal/core/cli/delegate/worktree.go`）：

1. 工作目录在 git 仓库里：在 `<cwd>/.nomi-delegate/<id>` 建 detached HEAD 的 worktree，编程助手标签在里面工作；
   `.nomi-delegate/` 写进仓库的 `info/exclude`。
2. 任务成功后把改动的文件拷回主工作树；目标文件已被用户或别的委派改过时不覆盖，列进结果的 `conflictedFiles`。
   worktree 保留到不再需要 `delegate_followup`。
3. 取消或授权失败时拆掉 worktree；应用重启时仍在运行的任务标为中断并清理。
4. 非 git 目录在原目录运行，并在结果里提示并行任务会互相改文件。
5. 同时运行的委派最多 3 个（`MaxParallelDelegates`）。

编程助手自带的沙箱（如 Codex 的 Seatbelt）照常生效；这一层只解决并行写同一工作树。

## 网络

- 出站 URL 只允许公网 http(s)，拒绝内嵌凭据与保留地址（`internal/core/security/netguard.go`）；网关出站另有地址分类与 DNS 钉 IP
  （`internal/gateway/net`），防解析后被重绑定到内网。
- 网关、契约服务都只监听回环地址，并校验 `Host` 头。

## 密钥与隐私

- API Key 等机密：系统钥匙串里存一把主密钥，磁盘上存加密后的 `enc:` 值（`internal/core/security/secretbox.go`）；钥匙串不可用时失败关闭，不落明文。
- 隐私模式：网关发给上游前把密钥、令牌等敏感串换成占位符，响应回来再换回（`internal/gateway/privacy`）。
- 诊断日志与审计记录写入前脱敏（`internal/core/services/redact.go`、`audit_log.go`）。
