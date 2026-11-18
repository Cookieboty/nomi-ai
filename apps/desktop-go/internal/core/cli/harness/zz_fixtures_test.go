package harness

// 跨平台测试夹具：claude_launch_mode_test 等不依赖系统的用例也要在 Windows 上编译，
// 所以 fakeChild 放在无构建标签的文件里（原来只在 freeze_unix_test.go 里定义，Windows 下 vet / 编译失败）。

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"

// fakeChild：标签起的 CLI 进程（只用到 PID 与是否还活着）
type fakeChild struct{ pid int }

func (c fakeChild) PID() int                   { return c.pid }
func (c fakeChild) ExitCode() *int             { return nil }
func (c fakeChild) Killed() bool               { return false }
func (c fakeChild) Stdin() clisdk.StdinLike    { return nil }
func (c fakeChild) OnStdout(func(string))      {}
func (c fakeChild) OnStderr(func(string))      {}
func (c fakeChild) OnClose(func(*int, string)) {}
func (c fakeChild) OnError(func(error))        {}
func (c fakeChild) Kill(string) bool           { return false }
