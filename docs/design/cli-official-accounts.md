# 编程助手官方账号（历史设计稿 · 已冻结）

> **状态：已废弃（v2.0.0）**。本稿描述的「保险箱存凭据 + 全局 activate / credEnc / import-current」已下线，**不再作为实现规范**。
>
> **现行规范**：[编程助手插件化 §5.10](cli-plugin-architecture.md)（账号目录模型）及同文档的隔离不变式 S1～S11、§5.10.9 迁移。
>
> 起草与查证历史（Claude / Codex / Grok / Gemini / cc-switch）仍保留在下方「附录：历史背景」供对照；**请勿再按本节实现或教用户使用 vault / 全局切换 / 导入当前登录。**

## 现行模型（v2.0.0）

| 旧（本稿，已废弃） | 新（§5.10） |
| --- | --- |
| 保险箱 `<kind>.json` + `credEnc`（safeStorage） | `accounts.json` 只存展示信息；凭据只在各账号目录 / CLI 自己的存储里 |
| 全局 `activate` 改写 `~/.claude` 等用户目录 | **默认账号** = 新标签默认用哪个账号目录；多账号并行 |
| `import-current` 把全局登录拷进保险箱 | 登录在账号目录里由 CLI 自己完成；「本机登录」条目指向用户原目录 |
| Nomi 读钥匙串 / 凭据文件做切换 | Nomi **不** get/set 凭据（S7）；删除账号时仅 `keychain.remove` / CLI logout |
| 切换时改写全局凭据 | 换账号 = 换 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 等，不碰其它账号目录 |

实现入口：`packages/electron/src/cli/accounts/AccountService.ts`、界面「编程助手 → 官方账号」。

迁移（§5.10.9）：启动时把旧保险箱转成 `needsLogin` 记录并写出 `accounts.json` **之后**才删除 / 归档保险箱与 backups/staging；解析失败则尽量 stub + 归档到 `vault-unreadable/`，写盘失败则保留原文件。

## 已废弃章节（勿再实现）

下列原章节标题保留索引，正文已删除：

- ~~§1 目标（全局切换）~~ → 见 §5.10 多账号并行
- ~~§2 cc-switch 对照里「替换钥匙串 / 写回全局」的 Nomi 列~~ → 已废弃
- ~~§4 登录后「收进保险箱」~~ → 登录留在账号目录
- ~~§5 全局切换（回收 / 备份 / 写入全局）~~ → **已废弃**
- ~~§6 保险箱与 `activate` / `import-current` IPC~~ → **已废弃**；现行 IPC 为 list / create / login-* / set-default / remove / rename 等（无 activate、无 import-current、无 credEnc）
- ~~§9 A1～A3 保险箱阶段~~ → 由 M0.7 / §5.10.9 取代

Gemini 后端、跨平台路径、非交互登录**命令**等与「在隔离目录里跑官方 login」相关的事实，已并入 [cli-plugin-architecture §5.10](cli-plugin-architecture.md) 与插件适配器；请以插件化文档与代码为准。

## 附录：历史背景（只读）

Anthropic [法务与合规](https://code.claude.com/docs/en/legal-and-compliance) 明确第三方不得收集、存储或中转 Claude.ai 凭据；本稿保险箱方案与此冲突，故 v2.0.0 起全面改为账号目录。各 CLI 凭据落点与登录命令的**历史实测笔记**见 git 历史中本文件的旧版本（v1.x）；现行行为以源码与 §5.10 为准。
