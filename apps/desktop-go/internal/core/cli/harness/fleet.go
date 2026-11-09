package harness

// fleet.go：给 Agent 看板（core/fleet）用的：标签起的 CLI 进程、等用户回应的授权，以及冻结 / 恢复标签的进程树
// （内存紧张时暂停：进程不占 CPU、内存由系统压缩换出，恢复后这一轮从原处接着跑，委派 / 任务察觉不到）。
// 与编排器的其余方法一样，须持 jsrt GIL 调用。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

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

// FrozenTab：被冻结的标签（By：memory = 内存守护自动暂停；user = 用户手动暂停；nomi = Nomi 暂停的）。
// Starts：冻结时各进程的启动时间，恢复前比对，pid 被复用的不碰
type FrozenTab struct {
	Pids   []int
	Starts map[int]string
	By     string
	At     time.Time
}

// frozenRecord：落盘的冻结记录（Nomi 崩溃 / 被强杀后，下次启动据此把还停着的进程恢复）
type frozenRecord struct {
	Pid   int    `json:"pid"`
	Start string `json:"start"`
}

func (o *Orchestrator) frozenPath() string { return filepath.Join(o.d.Root, "frozen.json") }

// saveFrozen：把当前冻结的进程写盘（没有冻结的就删掉文件）
func (o *Orchestrator) saveFrozen() {
	if o.d.Root == "" {
		return
	}
	recs := []frozenRecord{}
	for _, f := range o.frozen {
		for _, p := range f.Pids {
			recs = append(recs, frozenRecord{Pid: p, Start: f.Starts[p]})
		}
	}
	if len(recs) == 0 {
		_ = os.Remove(o.frozenPath())
		return
	}
	b, _ := json.Marshal(recs)
	_ = os.MkdirAll(o.d.Root, 0o755)
	if err := os.WriteFile(o.frozenPath(), b, 0o600); err != nil {
		o.d.Logger.Warn("harness frozen record write failed", util.NewObj("error", err.Error()))
	}
}

// recoverFrozen：启动时恢复上次没来得及恢复的进程（崩溃 / 强杀）：只恢复启动时间对得上的，pid 被复用的不碰
func (o *Orchestrator) recoverFrozen() {
	if o.d.Root == "" {
		return
	}
	b, err := os.ReadFile(o.frozenPath())
	if err != nil {
		return
	}
	_ = os.Remove(o.frozenPath())
	var recs []frozenRecord
	if json.Unmarshal(b, &recs) != nil {
		return
	}
	pids := make([]int, 0, len(recs))
	for _, r := range recs {
		pids = append(pids, r.Pid)
	}
	now := procStarts(pids)
	n := 0
	for i := len(recs) - 1; i >= 0; i-- {
		r := recs[i]
		if r.Pid > 1 && r.Start != "" && now[r.Pid] == r.Start && resumePid(r.Pid) == nil {
			n++
		}
	}
	if n > 0 {
		o.d.Logger.Info("harness resumed processes left frozen by the last run", util.NewObj("count", float64(n)))
	}
}

// pausedByMemory：内存守护冻结时传的 by（fleet.PausedByMemory）
const pausedByMemory = "memory"

// FreezeTab：冻结标签的进程树（pids 由调用方从进程表里展开，含根进程；父进程在前）。
// 只冻结有活着的 CLI 进程的标签；已经冻结的不重复冻结。
func (o *Orchestrator) FreezeTab(id string, pids []int, by string) bool {
	if o.tab(id) == nil || len(o.TabPids(id)) == 0 || len(pids) == 0 {
		return false
	}
	if _, ok := o.frozen[id]; ok {
		return false
	}
	// 内存守护不冻用户正看着的标签（窗口在前台、当前就是这个标签）：冻了也省不出多少，只会让正在等回复的这一轮卡住。
	// fleet 选候选时已经排除（Deps.Foreground）；这里再守一次，防止选完到冻结之间用户切了过来
	if by == pausedByMemory && id == o.ForegroundTab() {
		return false
	}
	if o.frozen == nil {
		o.frozen = map[string]*FrozenTab{}
	}
	starts := procStarts(pids)
	done := []int{}
	for _, p := range pids {
		// 读不到启动时间的不冻：之后没法确认还是它，宁可不动
		if p > 1 && starts[p] != "" && suspendPid(p) == nil {
			done = append(done, p)
		}
	}
	if len(done) == 0 {
		return false
	}
	o.frozen[id] = &FrozenTab{Pids: done, Starts: starts, By: by, At: time.Now()}
	o.saveFrozen()
	o.d.Logger.Info("harness tab frozen", util.NewObj("tabId", id, "by", by, "processes", float64(len(done))))
	o.changed()
	return true
}

// ThawTab：恢复被冻结的标签（子进程在前恢复，父进程最后）；没冻结时返回 false
func (o *Orchestrator) ThawTab(id string) bool {
	f := o.frozen[id]
	if f == nil {
		return false
	}
	delete(o.frozen, id)
	now := procStarts(f.Pids)
	for i := len(f.Pids) - 1; i >= 0; i-- {
		// 只恢复还是当初那个的进程（期间退出、pid 被别的程序复用的不碰）
		if p := f.Pids[i]; now[p] == f.Starts[p] {
			_ = resumePid(p)
		}
	}
	o.saveFrozen()
	o.d.Logger.Info("harness tab thawed", util.NewObj("tabId", id))
	if o.tab(id) != nil {
		o.changed()
	}
	return true
}

// thawIfFrozen：任何要动这个标签的操作（停止、关闭、发消息、插话、审批、拆进程）之前先恢复：
// 冻结的进程收不到中断、也答不了话
func (o *Orchestrator) thawIfFrozen(id string) {
	if o.frozen[id] != nil {
		o.ThawTab(id)
	}
}

// thawAll：退出前恢复所有冻结的进程（不能把用户的 CLI 留在冻结状态）
func (o *Orchestrator) thawAll() {
	for id := range o.frozen {
		o.ThawTab(id)
	}
}

// FrozenTabs：当前冻结的标签（副本）
func (o *Orchestrator) FrozenTabs() map[string]FrozenTab {
	out := make(map[string]FrozenTab, len(o.frozen))
	for id, f := range o.frozen {
		out[id] = *f
	}
	return out
}

// LastReply：标签最后一条助手回复（Agent 看板「已完成」卡片上的总结用）；没有时空串
func (o *Orchestrator) LastReply(id string) string {
	if o.tab(id) == nil || id == MainTabID {
		return ""
	}
	msgs := o.TabMessages(id)
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		if m == nil || m.Get("role") != "assistant" {
			continue
		}
		if s, _ := m.Get("content").(string); s != "" {
			return s
		}
	}
	return ""
}
