---
'@nomi-ai/ai-chat': patch
---

fix(resource-preview): 内联文件链接的路径解析更准。首段与工作区根目录名重复的相对路径（工作区 `xy-token-api/` 下点 `xy-token-api/foo.md`）现在会剥掉重复段再找，同时仍优先命中真实的同名子目录；`.../x/y` 这类省略路径查不到时返回 missing 而不报 ambiguous，扫描上限截断、嵌套 git worktree 副本不再把唯一结果变成「有歧义」；多个候选根之间遇到 ambiguous 会继续往后试，只有全部失败才报歧义。/ Inline file links now resolve more reliably: a relative path that repeats the workspace root's own name (`xy-token-api/foo.md` inside `.../xy-token-api`) is retried with that segment stripped while a real same-named subdirectory still wins, an elided `.../x/y` path that matches nothing reports missing instead of ambiguous, nested git worktree copies and the scan cap no longer turn a single match into "ambiguous", and an ambiguous hit in one candidate root keeps trying the remaining roots.
