---
---

fix(desktop): the command allowlist only accepts known test / build / check / read-only commands
(e.g. `pnpm test`, `go vet`, `git diff`, `tsc`), never a bare program such as `make`, and refuses
arguments that run another program or write anywhere (`-exec`, `-toolexec`, `-vettool`, `--output`,
`-O`, `--config`). It no longer overrides "confirm each change" mode or a tool set to "always ask",
and after a turn that read outside content and edited files it stays paused until you confirm a
command yourself (at most 24 hours). Saved rules that no longer qualify are dropped.
