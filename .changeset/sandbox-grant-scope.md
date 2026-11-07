---
'@nomi-ai/desktop-go': patch
---

fix(security): 编程助手沙箱的授权收紧。被挡下的写入只放开最小的范围（所在文件夹，或它所在的 git 仓库），不再一次放开 `~/Projects` 这样的大文件夹；开机自启、命令目录（如 `~/.local/bin`、`/opt/homebrew/bin`）和 shell 配置（如 `~/.zshrc`、`~/.gitconfig`）不能授权写入；「始终允许」都只在点它的那个项目里生效；Nomi 意外退出后，被暂停的编程助手会在下次启动时自动恢复。/ The coding-agent sandbox grants are tighter. A blocked write now opens only the smallest scope (its folder, or the git repository it sits in) instead of a large folder like `~/Projects`; login items, command directories (such as `~/.local/bin` and `/opt/homebrew/bin`) and shell configuration (such as `~/.zshrc` and `~/.gitconfig`) can no longer be granted; "Always allow" applies only to the project it was given in; and coding agents paused when Nomi quit unexpectedly are resumed on the next start.
