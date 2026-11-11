---
'@nomi-ai/desktop-go': patch
---

fix(projects): 会话里的文件链接跳到同一项目的其他文件夹或别的项目时，直接打开、可以编辑，不再要求逐个文件授权。迁移到项目时，暂时不能用的目录（外接盘没挂、网络目录离线）保留对话原来的工作目录，目录回来后下次启动补迁；迁移中途写入失败时下次启动接着做完，全部成功才算完成。 / A file link in a chat that points into another folder of the same project, or into another project, opens directly and is editable, with no per-file permission prompt. When moving to projects, a folder that is unavailable right now (an unmounted drive, an offline network folder) keeps the chat's working folder and is moved at a later startup once it is back; a move that fails partway is finished at the next startup and only counts as done when every step succeeds.
