---
'@nomi-ai/desktop-go': patch
---

fix(desktop): 命令白名单按 shell 去掉引号后的实际参数检查危险选项，带引号或部分引号的 `-exec`、`--output` 等以及 git 长选项缩写（如 `--outp=`）不再凭已记住的 `go test` / `git diff` 直接放行（#265）。/ The command allowlist now checks dangerous options against the arguments the shell actually passes (quotes removed), so quoted or partly quoted `-exec`, `--output` etc. and abbreviated git long options (such as `--outp=`) no longer run unasked under a remembered `go test` / `git diff` rule (#265).
