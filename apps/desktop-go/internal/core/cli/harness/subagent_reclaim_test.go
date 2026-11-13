package harness

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 只模拟 RPC 读写和退出；不启动真实 CLI，也不依赖机器上的账号与沙箱配置。
type subagentReclaimChild struct {
	killed bool
	stdout []func(string)
	closes []func(*int, string)
	start  *util.Obj
}

func (c *subagentReclaimChild) PID() int                      { return 0 }
func (c *subagentReclaimChild) ExitCode() *int                { return nil }
func (c *subagentReclaimChild) Killed() bool                  { return c.killed }
func (c *subagentReclaimChild) Stdin() clisdk.StdinLike       { return c }
func (c *subagentReclaimChild) OnStdout(fn func(string))      { c.stdout = append(c.stdout, fn) }
func (c *subagentReclaimChild) OnStderr(func(string))         {}
func (c *subagentReclaimChild) OnClose(fn func(*int, string)) { c.closes = append(c.closes, fn) }
func (c *subagentReclaimChild) OnError(func(error))           {}
func (c *subagentReclaimChild) Writable() bool                { return !c.killed }
func (c *subagentReclaimChild) End()                          {}
func (c *subagentReclaimChild) Write(s string) bool {
	v, _ := util.ParseString(s)
	c.start = util.AsObj(v)
	return true
}
func (c *subagentReclaimChild) Kill(string) bool {
	c.killed = true
	jsrt.QueueMicrotask(func() {
		for _, fn := range c.closes {
			fn(nil, "")
		}
	})
	return true
}
func (c *subagentReclaimChild) send(msg *util.Obj) {
	for _, fn := range c.stdout {
		fn(util.Stringify(msg) + "\n")
	}
}
func (c *subagentReclaimChild) notify(method, threadID string) {
	c.send(util.NewObj("method", method, "params", util.NewObj("threadId", threadID,
		"turn", util.NewObj("id", "ct1", "status", "completed"))))
}

func TestCodexSubagentPreventsIdleReclaim(t *testing.T) {
	for _, memory := range []bool{false, true} {
		for _, state := range []string{"native", "fork", "original-with-idle-fork", "pending-start"} {
			t.Run(state+"/memory="+util.JSString(memory), func(t *testing.T) {
				o := titleTestOrch(t)
				defer jsrt.Run(o.Dispose)
				jsrt.Run(func() {
					tab := o.CreateTab(util.NewObj("backend", "codex", "cliSessionId", "root-thread"))
					id := str(tab, "id")
					child := &subagentReclaimChild{}
					d := drivers.NewAppServerDriver(drivers.AppServerDriverOptions{Child: child})
					d.NoteChild("c1", "call1")
					target := "c1"
					if state == "fork" || state == "original-with-idle-fork" {
						d.SetFork("c1", "f1")
						if state == "fork" {
							target = "f1"
						}
					}
					var pending *jsrt.Promise[string]
					if state == "pending-start" {
						pending = d.SendToThread("c1", []any{}, nil, false)
					} else {
						child.notify("turn/started", target)
					}
					// 主轮次与标签都是空闲，子代理可以长时间没有任何通知。
					o.live.setCodex(id, &codexLiveSession{driver: d, lastActivityAt: nowMs() - 120_000, used: true})
					o.idleReclaimMs = 60_000
					sweep := func() []string {
						if memory {
							return o.ReclaimIdleNow()
						}
						return o.ReclaimIdle(nowMs())
					}
					if picked := sweep(); len(picked) != 0 || child.killed {
						t.Fatalf("active subagent reclaimed: picked=%v killed=%v", picked, child.killed)
					}
					if pending != nil {
						child.send(util.NewObj("id", child.start.Get("id"), "result", util.NewObj("turn", util.NewObj("id", "ct1"))))
						if _, err := jsrt.Await(pending); err != nil {
							t.Fatal(err)
						}
					}
					child.notify("turn/completed", target)
					if picked := sweep(); len(picked) != 1 || picked[0] != id || !child.killed {
						t.Fatalf("finished subagent must allow reclaim: picked=%v killed=%v", picked, child.killed)
					}
				})
			})
		}
	}
}
