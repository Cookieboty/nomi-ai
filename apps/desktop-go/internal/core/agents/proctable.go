package agents

// proctable.go：进程表（父子关系 + 常驻内存 + 累计 CPU 时间），给 Agent 看板与负荷调度用：
// 算一个进程连同子孙进程的内存与 CPU 占用，判断进程在不在 Nomi 的进程树里
// （在 = 工坊标签、Nomi 派出的编程助手；不在 = 用户自己在终端 / IDE 里开的，只能预警不能干扰）。

import (
	"sort"
	"time"
)

// ProcTable：某一时刻的进程快照。pid 会被系统复用，快照只在采样当下有效。
// At = 采样时间（ReadProcTable 填；NewProcTable 留零值，由调用方设置）。
type ProcTable struct {
	At       time.Time
	procs    map[float64]RawProc
	children map[float64][]float64
	// 整机累计 CPU 时间（SystemCPU）；sysOK = false 表示读不到
	sysBusy, sysTotal float64
	sysOK             bool
}

// NewProcTable：从进程列表建表（重复的 pid 以后出现的为准）。
func NewProcTable(procs []RawProc) *ProcTable {
	t := &ProcTable{procs: make(map[float64]RawProc, len(procs)), children: map[float64][]float64{}}
	for _, p := range procs {
		t.procs[p.Pid] = p
	}
	for pid, p := range t.procs {
		if p.Ppid != pid {
			t.children[p.Ppid] = append(t.children[p.Ppid], pid)
		}
	}
	for k := range t.children {
		sort.Float64s(t.children[k])
	}
	return t
}

// ReadProcTable：读本机进程表（nil = 读不到）。
func ReadProcTable(platform string) *ProcTable {
	at := time.Now()
	procs := ReadProcesses(platform)
	if procs == nil {
		return nil
	}
	t := NewProcTable(procs)
	t.At = at
	t.sysBusy, t.sysTotal, t.sysOK = SystemCPU()
	return t
}

// SystemCPUSince：从 prev 到 t 整机 CPU 忙的比例（0–100，所有核一起算，同活动监视器的「系统 + 用户」）；
// ok = false 表示两份快照里有一份读不到整机 CPU
func (t *ProcTable) SystemCPUSince(prev *ProcTable) (pct float64, ok bool) {
	if prev == nil || !t.sysOK || !prev.sysOK {
		return 0, false
	}
	dt := t.sysTotal - prev.sysTotal
	if dt <= 0 {
		return 0, false
	}
	pct = (t.sysBusy - prev.sysBusy) / dt * 100
	return min(100, max(0, pct)), true
}

// CPUSince：pids 从 prev 到 t 这段时间的 CPU 占用（百分比，100 = 占满一个核，多核可超过 100）。
// 这段时间里新起的进程（prev 里没有，或累计时间变小 = pid 被复用）整段累计时间都算进来。
// 间隔不到 100 毫秒、或缺一份快照时返回 0。Linux 的 ps 只到秒，间隔太短会跳动，采样间隔要几秒。
func (t *ProcTable) CPUSince(prev *ProcTable, pids []float64) float64 {
	if prev == nil {
		return 0
	}
	dt := t.At.Sub(prev.At).Seconds()
	if dt < 0.1 {
		return 0
	}
	used := 0.0
	for _, pid := range pids {
		cur, ok := t.procs[pid]
		if !ok {
			continue
		}
		if old, ok := prev.procs[pid]; ok && old.CPU <= cur.CPU {
			used += cur.CPU - old.CPU
		} else {
			used += cur.CPU
		}
	}
	return used / dt * 100
}

// Get：pid 对应的进程。
func (t *ProcTable) Get(pid float64) (RawProc, bool) {
	p, ok := t.procs[pid]
	return p, ok
}

// Len：进程数。
func (t *ProcTable) Len() int { return len(t.procs) }

// IsUnder：pid 是 root 本身或它的子孙进程。沿父进程往上找，遇到环、缺失的父进程或 pid ≤ 1 就停。
func (t *ProcTable) IsUnder(pid, root float64) bool {
	seen := map[float64]bool{}
	for cur := pid; ; {
		if cur == root {
			return true
		}
		p, ok := t.procs[cur]
		if !ok || cur <= 1 || seen[cur] {
			return false
		}
		seen[cur] = true
		cur = p.Ppid
	}
}

// Subtree：root 及全部子孙进程的 pid（root 不在表里时为空）。
func (t *ProcTable) Subtree(root float64) []float64 {
	if _, ok := t.procs[root]; !ok {
		return nil
	}
	out := []float64{root}
	seen := map[float64]bool{root: true}
	for i := 0; i < len(out); i++ {
		for _, c := range t.children[out[i]] {
			if !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
	}
	return out
}

// TreeRSS：root 及子孙进程的常驻内存之和（字节）。
func (t *ProcTable) TreeRSS(root float64) float64 {
	sum := 0.0
	for _, pid := range t.Subtree(root) {
		sum += t.procs[pid].RSS
	}
	return sum
}

// AgentTree：一个编程助手的进程树。Root 是最上层被认出的编程助手进程（它子孙里再认出的编程助手
// 算进同一棵树，避免内存重复计算）；RSS 是整棵树之和；InNomi = 在 Nomi 自己的进程树里。
type AgentTree struct {
	Root   AgentProc
	Pids   []float64
	RSS    float64
	InNomi bool
}

// AgentTrees：表里的编程助手按进程树归并，按根 pid 排序。selfPid = Nomi 内核进程。
func AgentTrees(t *ProcTable, selfPid float64) []AgentTree {
	all := make([]RawProc, 0, len(t.procs))
	for _, p := range t.procs {
		all = append(all, p)
	}
	matched := map[float64]AgentProc{}
	for _, a := range Classify(all, selfPid) {
		matched[a.Pid] = a
	}
	out := []AgentTree{}
	for pid, a := range matched {
		if t.hasMatchedAncestor(pid, matched) {
			continue
		}
		pids := t.Subtree(pid)
		rss := 0.0
		for _, p := range pids {
			rss += t.procs[p].RSS
		}
		out = append(out, AgentTree{Root: a, Pids: pids, RSS: rss, InNomi: t.IsUnder(pid, selfPid)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Root.Pid < out[j].Root.Pid })
	return out
}

func (t *ProcTable) hasMatchedAncestor(pid float64, matched map[float64]AgentProc) bool {
	seen := map[float64]bool{pid: true}
	cur := t.procs[pid].Ppid
	for cur > 1 && !seen[cur] {
		if _, ok := matched[cur]; ok {
			return true
		}
		p, ok := t.procs[cur]
		if !ok {
			return false
		}
		seen[cur] = true
		cur = p.Ppid
	}
	return false
}

// Each：逐个进程（顺序不定）。
func (t *ProcTable) Each(fn func(RawProc)) {
	for _, p := range t.procs {
		fn(p)
	}
}
