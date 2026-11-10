package agents

import (
	"testing"
	"time"
)

// 没有编程助手进程时进程表至多每 IdleProcsMs 读一次；有进程时每轮都读
func TestRefreshProcsBacksOffWhenNoAgents(t *testing.T) {
	now := 1_000_000.0
	reads := 0
	var found []AgentProc
	s := New(Deps{Root: t.TempDir(), Now: func() float64 { return now }, Processes: func() []AgentProc {
		reads++
		return found
	}})
	s.refreshProcs()
	if reads != 1 {
		t.Fatalf("first read: %d", reads)
	}
	now += 8_000
	s.refreshProcs()
	if reads != 1 {
		t.Fatal("no agents: should not reread within IdleProcsMs")
	}
	now += IdleProcsMs
	found = []AgentProc{{Pid: 42, Kind: "claude"}}
	s.refreshProcs()
	if reads != 2 {
		t.Fatalf("after IdleProcsMs: %d", reads)
	}
	now += 8_000
	s.refreshProcs()
	if reads != 3 {
		t.Fatal("agents running: reread every poll")
	}
}

// 同一段时间里多处读进程表共用一次 ps
func TestReadProcessesIsShared(t *testing.T) {
	procShare.Lock()
	procShare.platform, procShare.at, procShare.procs = "test", time.Now(), []RawProc{{Pid: 7}}
	procShare.Unlock()
	t.Cleanup(func() {
		procShare.Lock()
		procShare.procs = nil
		procShare.Unlock()
	})
	if got := ReadProcesses("test"); len(got) != 1 || got[0].Pid != 7 {
		t.Fatalf("expected the shared list, got %v", got)
	}
	tbl := ReadProcTable("test")
	if tbl == nil || tbl.At.IsZero() {
		t.Fatal("proc table should reuse the shared list with its sample time")
	}
}
