---
'@nomi-ai/contract': patch
---

feat(chat): 输入框 `@` 引用路径时也可以补全 `node_modules`、`.venv`、`.next` 等原先写死跳过的依赖与缓存目录及其内部匹配文件；「文件」树仍然不递归展开这些大目录。被 `.gitignore` 忽略的文件继续在文件树里列出并置灰，也仍可被 `@` 引用。新增 `harness.workspaceMentionPaths` 查询（短列表，有搜索上限），不改变 `harness.workspaceList`。 Composer `@` mentions can also complete paths under previously skipped dependency and cache directories (`node_modules`, `.venv`, `.next`, and the other hardcoded skip dirs); the Files tree still does not recurse into those directories. Gitignored files remain listed and gray in the Files tree and stay mentionable. Adds the `harness.workspaceMentionPaths` query (a capped short list) without changing `harness.workspaceList`.
