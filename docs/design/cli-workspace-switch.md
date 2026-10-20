# 切换工作目录时带上对话（所有 CLI）

> 状态：已实现。代码：`packages/electron/src/cli/contextCarry.ts`、`CliHarnessService.setTabCwd / sendTab`、
> `packages/ai-chat/src/components/EndpointControls`。

## 问题

CLI 的会话和工作目录绑定，换目录后无法续接原会话：

| CLI         | 会话存放位置                                   | 换目录后能否 resume              |
| ----------- | ---------------------------------------------- | -------------------------------- |
| Claude Code | `~/.claude/projects/<编码后的 cwd>/<id>.jsonl` | 不能（按 cwd 找会话）            |
| Codex       | `~/.codex/sessions/…/rollout-*.jsonl`          | 会话里记着旧目录；未在新目录实测 |
| dsh         | `$DSH_HOME/sessions/<cwd>/session-*`           | 不能                             |
| Grok        | `~/.grok/sessions/<编码后的 cwd>/…`            | 按目录存放，视为不能             |
| Gemini      | `~/.gemini/tmp/<项目>/chats/session-*.jsonl`   | 不能（按项目找会话）             |

以前的做法是用系统确认框提示「上下文不会带过去」，只能选继续或取消。

## 做法

换目录时弹出应用内的对话框，三个选择：

- **带上当前对话**（默认）：把标签里的可见对话整理成一段前文，新会话的第一轮把它放在用户消息前面一起发出；
- **开新会话**：干净地开始，并清掉之前留下、还没发出的前文；
- **取消**。

全新标签（既没有 CLI 会话也没有对话）直接换，不弹框。正在运行的轮次不会被打断，会在原目录跑完。

前文的格式：

```
[Nomi] 以下是这个对话之前在 <旧目录> 里的内容……
<previous_conversation>
User: …
Assistant: …
</previous_conversation>

---

<用户这条消息>
```

- 前文只保存在主进程（`tabs/<id>.carry.txt`，权限 0600），界面只拿到条数（`carriedMessages`），
  输入栏显示「带上前文 · N 条」按钮，点 × 可以放弃。
- 第一轮成功后清除，之后的轮次由 CLI 自己续接。失败则保留，下一次再带。
- 读磁盘历史、生成标题时会去掉这段前文，只显示用户原话。
- 分叉 / 复制出来的 CLI 标签（预填了对话、没有 CLI 会话）走同一条路径，第一轮也会带上预填的对话。

## 长度限制（三平台）

Claude 与 Gemini 从 stdin 收消息，不受命令行长度限制；Codex / dsh / Grok 把消息放在命令行参数里：

- Windows：npm 安装的是 `.cmd` 垫片，经 cmd.exe 启动，整条命令行上限 8191 字符 → 前文最多 5000 字符；
- Linux：单个参数上限 128 KB（中文 UTF-8 一个字 3 字节）→ 前文最多 30000 字符；
- macOS：参数总量约 1 MB → 同样按 30000 字符。

超出预算时从最早的消息开始丢，连一条都放不下就不带。
