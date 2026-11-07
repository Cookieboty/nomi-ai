package harness

// fleet.go：给 Agent 看板（core/fleet）用的只读查询：标签起的 CLI 进程、等用户回应的授权。
// 与编排器的其余方法一样，须持 jsrt GIL 调用。

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"

func procAlive(ch clisdk.ChildLike) bool {
	return ch != nil && ch.PID() > 0 && ch.ExitCode() == nil && !ch.Killed()
}

func aliveProcs(list []clisdk.ChildLike) []clisdk.ChildLike {
	out := list[:0]
	for _, ch := range list {
		if procAlive(ch) {
			out = append(out, ch)
		}
	}
	return out
}

// trackProc：记下标签起的 CLI 进程（顺手丢掉已经退出的）
func (o *Orchestrator) trackProc(tabID string, ch clisdk.ChildLike) {
	if tabID == "" || ch == nil {
		return
	}
	if o.tabProcs == nil {
		o.tabProcs = map[string][]clisdk.ChildLike{}
	}
	o.tabProcs[tabID] = append(aliveProcs(o.tabProcs[tabID]), ch)
}

// TabPids：标签当前还活着的 CLI 进程号（启动的那个进程；子进程由调用方从进程表里展开）。
// 标签已经关掉的一并清理。
func (o *Orchestrator) TabPids(tabID string) []int {
	list := aliveProcs(o.tabProcs[tabID])
	if len(list) == 0 || o.tab(tabID) == nil {
		delete(o.tabProcs, tabID)
		return nil
	}
	o.tabProcs[tabID] = list
	out := make([]int, len(list))
	for i, ch := range list {
		out[i] = ch.PID()
	}
	return out
}

// PendingPermissions：标签上等用户回应的授权请求数
func (o *Orchestrator) PendingPermissions(tabID string) int {
	return len(o.pendingPerms.Get(tabID))
}
