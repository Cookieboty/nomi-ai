---
'@nomi-ai/electron': patch
---

修复第三方 Claude Code 标签的小模型设置不生效（#98）：注入的 `ANTHROPIC_SMALL_FAST_MODEL` 不再被随后的继承变量清理删掉，只清除从父进程继承来的同名旧值。
