---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(sidebar): 编程助手的会话工作目录在某个已有项目里就自动归进那个项目（新建、从本机历史打开、Nomi 委派开的 worktree 标签；启动时与新建 / 修改项目时把以前的会话也补上；选了「不使用项目」的不再自动归回）。改了项目文件夹时，工作目录还在项目里的会话不再被挪到主文件夹。侧栏「最近」改名「其他对话」，去掉它标题上和项目行重复的新建；工坊「按端」看时不再列这个端没有会话的项目，折叠的项目不再显示 0；新建菜单里选的项目只管这一次；新建失败时给出原因。 / Coding-agent sessions whose working folder is inside an existing project are now filed under that project (new tabs, sessions opened from local history, and worktree tabs Nomi delegates; older sessions are filed at startup and when a project is created or edited; a tab set to "No project" stays out). Editing a project's folders no longer moves a session that is still inside the project to the main folder. The "Recent" section is renamed "Other chats" and loses its new-chat button, which duplicated the one on each project row. Viewing one endpoint no longer lists projects that have no sessions on it, and a collapsed project no longer shows 0. A project picked in the new-chat menu only applies to that one chat, and a failed new chat now says why.
