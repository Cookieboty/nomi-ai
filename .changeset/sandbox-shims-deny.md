---
'@nomi-ai/desktop-go': patch
---

fix(sandbox): 隐藏目录默认可写后，版本管理器的命令入口（`~/.pyenv/shims`、`~/.rbenv/shims`、`~/.asdf/shims`、mise、Volta 等）重新默认拒写，沙箱里的编程助手改不了你在沙箱外调用的 python / ruby / node（#302）；工具的日志、缓存照常能写。
