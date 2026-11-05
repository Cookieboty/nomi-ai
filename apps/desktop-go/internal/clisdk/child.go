package clisdk

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"

// StdinLike = ChildLike.stdin。
type StdinLike interface {
	Writable() bool
	Write(chunk string) bool
	End()
}

// ChildLike：子进程接口（所有方法持 jsrt 锁调用；回调也在锁内到来）。
type ChildLike interface {
	PID() int // 0 = undefined
	ExitCode() *int
	Killed() bool
	Stdin() StdinLike
	OnStdout(func(string))
	OnStderr(func(string))
	OnClose(func(code *int, signal string))
	OnError(func(error))
	Kill(signal string) bool
}

// SpawnFn 启动子进程。
type SpawnFn func(command string, args []string, cwd string) ChildLike

// KillFn 结束子进程。
type KillFn func(child ChildLike)

// ProcChild 把 nodeproc.Child 适配成 ChildLike。
type ProcChild struct{ *nodeproc.Child }

func (p ProcChild) PID() int         { return p.Child.Pid }
func (p ProcChild) Stdin() StdinLike { return p.Child.Stdin }
func (p ProcChild) ExitCode() *int   { return p.Child.ExitCode() }

// EndChild：关掉 stdin 并结束子进程。
func EndChild(child ChildLike, kill KillFn) {
	func() {
		defer func() { _ = recover() }()
		if child.Stdin().Writable() {
			child.Stdin().End()
		}
	}()
	func() {
		defer func() { _ = recover() }()
		if !child.Killed() && child.ExitCode() == nil {
			if kill != nil {
				kill(child)
			} else {
				child.Kill("")
			}
		}
	}()
}

// StderrTail：stderr 的末尾（n 按 UTF-16 码元截尾）。
func StderrTail(child ChildLike, n int) func() string {
	if n == 0 {
		n = 4000
	}
	tail := ""
	child.OnStderr(func(c string) { tail = SliceFrom(tail+c, -n) })
	return func() string { return tail }
}
