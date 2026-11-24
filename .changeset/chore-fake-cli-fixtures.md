---
---

chore(desktop-go): 跨平台 Claude 协议替身与测试清理

- `shellhandlers` 的假 Claude CLI 从 Python 脚本换成独立 Go 程序 `testdata/fakeclaude`（只用标准库，`go build` 后复制进各 fixture）：按 OS 编出可执行文件，直接在前身脚本同样的 stdin/stdout/stderr 上说到同样的 stream-json 帧，macOS / Windows 上也能跑，不依赖本机 Python
- 桌面根包的假 `claude` 改为复制测试二进制并靠 `TestMain` 自派发：只要被启动就写标记并非零退出，测试据此断言只做了可执行检测、没有真的运行它；`PATH` 只含假目录
- Codex fixture 没有替换成 Go 替身：仍是用 `#!/bin/sh` 启动 Python 脚本的 POSIX fixture（Windows 跳过，没有 python3 也跳过），本次只把 cwd 断言改成比较物理路径（macOS 的 `/var` → `/private/var` 别名不影响判定）；`mainchat` / `claudert` / `codexrt` 的工厂测试同样只改物理路径断言
- 失败时按真实错误直接报（检查 `os.WriteFile` / `os.Mkdir` / `os.Symlink` 等，不再用 `_ =` 吞掉）；`registry_test` 补注册表的清理，IPC 失败日志打印错误详情而不是指针
- 仍只是协议级替身：没有安装、登录或调用任何真实官方 CLI，原生 Windows / macOS 待最终 CI 结论
- 只动 Go 桌面内核的测试与替身（changesets 里不参与版本化的包），只写一条 empty changeset
