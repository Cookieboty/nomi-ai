---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

feat(conversation): 对话里的相对路径链接和像路径的行内代码按工作区文件索引解析，点开在侧栏里看，不再交给系统浏览器；按文件名查找时跳过 node_modules / vendor / dist 等目录。 Relative file links and path-like inline code in messages resolve against the workspace file index and open in the side pane instead of the system browser; the file lookup skips node_modules, vendor, dist and similar folders.
