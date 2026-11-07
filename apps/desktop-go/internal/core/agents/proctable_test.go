package agents

import (
	"math"
	"reflect"
	"testing"
	"time"
)

func TestParsePsWithParentAndRSS(t *testing.T) {
	out := "    1     0  15040 348:52.48 /sbin/launchd    /sbin/launchd\n" +
		"  300     1   2048   0:01.50 /opt/homebrew/bi /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js\n" +
		"  301   300      4 1-02:03:04 zsh\n" +
		"garbage line\n"
	got := ParsePs(out)
	want := []RawProc{
		{Pid: 1, Ppid: 0, RSS: 15040 * 1024, CPU: 348*60 + 52.48, Name: "launchd", Cmd: "/sbin/launchd"},
		{Pid: 300, Ppid: 1, RSS: 2048 * 1024, CPU: 1.5, Name: "bi", Cmd: "/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"},
		{Pid: 301, Ppid: 300, RSS: 4 * 1024, CPU: 86400 + 2*3600 + 3*60 + 4, Name: "zsh", Cmd: "zsh"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParsePs =\n%+v\nwant\n%+v", got, want)
	}
}

func TestParseWinJsonWithParentAndRSS(t *testing.T) {
	got := ParseWinJson(`[{"ProcessId":10,"ParentProcessId":4,"WorkingSetSize":1048576,"KernelModeTime":5000000,"UserModeTime":15000000,"Name":"codex.exe","CommandLine":"codex.exe exec"},` +
		`{"ProcessId":11,"Name":"svc.exe","CommandLine":null}]`)
	want := []RawProc{
		{Pid: 10, Ppid: 4, RSS: 1048576, CPU: 2, Name: "codex", Cmd: "codex.exe exec"},
		{Pid: 11, Name: "svc", Cmd: "svc.exe"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseWinJson =\n%+v\nwant\n%+v", got, want)
	}
}

func TestClassifySkipsChatGPTCodexFramework(t *testing.T) {
	procs := []RawProc{
		{Pid: 5, Name: "Ch", Cmd: "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/1/Helpers/browser_crashpad_handler --monitor-self"},
		{Pid: 6, Name: "codex", Cmd: "/usr/local/bin/codex exec", Ppid: 1, RSS: 10},
	}
	got := Classify(procs, 999)
	want := []AgentProc{{Pid: 6, Kind: "codex", Ppid: 1, RSS: 10}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Classify = %+v, want %+v", got, want)
	}
}

// 进程树：
//
//	1 launchd
//	├ 100 nomi（内核）
//	│ └ 110 node …claude-code/cli.js（工坊标签）
//	│   ├ 111 node（测试）
//	│   └ 112 codex exec（Claude 里又调了 codex：归进 110 的树）
//	├ 200 zsh（用户终端）
//	│ └ 210 codex（用户自己开的）
//	│   └ 211 cargo
//	└ 300 gemini（父进程已退出）
func sampleTable() *ProcTable {
	const mb = 1024 * 1024
	return NewProcTable([]RawProc{
		{Pid: 1, Ppid: 0, RSS: 10 * mb, Name: "launchd", Cmd: "/sbin/launchd"},
		{Pid: 100, Ppid: 1, RSS: 300 * mb, Name: "Nomi", Cmd: "/Applications/Nomi.app/Contents/MacOS/Nomi"},
		{Pid: 110, Ppid: 100, RSS: 500 * mb, Name: "node", Cmd: "node /x/@anthropic-ai/claude-code/cli.js"},
		{Pid: 111, Ppid: 110, RSS: 200 * mb, Name: "node", Cmd: "node vitest"},
		{Pid: 112, Ppid: 110, RSS: 100 * mb, Name: "codex", Cmd: "codex exec"},
		{Pid: 200, Ppid: 1, RSS: 5 * mb, Name: "zsh", Cmd: "-zsh"},
		{Pid: 210, Ppid: 200, RSS: 400 * mb, Name: "codex", Cmd: "codex"},
		{Pid: 211, Ppid: 210, RSS: 900 * mb, Name: "cargo", Cmd: "cargo build"},
		{Pid: 300, Ppid: 299, RSS: 50 * mb, Name: "gemini", Cmd: "gemini"},
	})
}

func TestProcTableTree(t *testing.T) {
	tb := sampleTable()
	if !tb.IsUnder(112, 100) || !tb.IsUnder(100, 100) {
		t.Fatal("112 and 100 should be under Nomi")
	}
	if tb.IsUnder(211, 100) || tb.IsUnder(300, 100) || tb.IsUnder(1, 100) {
		t.Fatal("user terminal, orphan and launchd are not under Nomi")
	}
	if got, want := tb.Subtree(110), []float64{110, 111, 112}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Subtree(110) = %v, want %v", got, want)
	}
	if tb.Subtree(42) != nil {
		t.Fatal("missing root has no subtree")
	}
	if got, want := tb.TreeRSS(210), float64(1300*1024*1024); got != want {
		t.Fatalf("TreeRSS(210) = %v, want %v", got, want)
	}
}

func TestProcTableCycleIsSafe(t *testing.T) {
	tb := NewProcTable([]RawProc{{Pid: 7, Ppid: 8}, {Pid: 8, Ppid: 7}, {Pid: 9, Ppid: 9}})
	if tb.IsUnder(7, 100) || tb.IsUnder(9, 100) {
		t.Fatal("cycle must not be under 100")
	}
	if got := len(tb.Subtree(7)); got != 2 {
		t.Fatalf("Subtree over a cycle = %d pids, want 2", got)
	}
}

func TestAgentTrees(t *testing.T) {
	const mb = 1024 * 1024
	got := AgentTrees(sampleTable(), 100)
	if len(got) != 3 {
		t.Fatalf("AgentTrees = %+v, want 3 trees", got)
	}
	want := []struct {
		pid    float64
		kind   string
		rss    float64
		inNomi bool
	}{
		{110, "claude", 800 * mb, true}, // 包含子进程 codex，不单独成树
		{210, "codex", 1300 * mb, false},
		{300, "gemini", 50 * mb, false},
	}
	for i, w := range want {
		g := got[i]
		if g.Root.Pid != w.pid || g.Root.Kind != w.kind || g.RSS != w.rss || g.InNomi != w.inNomi {
			t.Errorf("tree %d = {pid %v kind %s rss %v inNomi %v}, want %+v", i, g.Root.Pid, g.Root.Kind, g.RSS, g.InNomi, w)
		}
	}
}

func TestParseCPUTime(t *testing.T) {
	cases := map[string]float64{
		"0:00.00":    0,
		"0:01.23":    1.23,
		"819:52.89":  819*60 + 52.89,
		"00:00:07":   7,
		"01:02:03":   3723,
		"3-00:00:01": 3*86400 + 1,
		"":           0,
		"abc":        0,
		"1:2:3:4":    0,
		"x-01:00:00": 0,
		"-1:00":      0,
		"0:-1":       0,
	}
	for in, want := range cases {
		if got := ParseCPUTime(in); math.Abs(got-want) > 1e-9 {
			t.Errorf("ParseCPUTime(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestCPUSince(t *testing.T) {
	t0 := time.Unix(1000, 0)
	prev := NewProcTable([]RawProc{
		{Pid: 10, Ppid: 1, CPU: 100},
		{Pid: 11, Ppid: 10, CPU: 50},
		{Pid: 12, Ppid: 10, CPU: 80}, // 这段时间里退出了
		{Pid: 13, Ppid: 10, CPU: 90}, // pid 被复用：累计时间变小
	})
	prev.At = t0
	cur := NewProcTable([]RawProc{
		{Pid: 10, Ppid: 1, CPU: 102}, // +2s
		{Pid: 11, Ppid: 10, CPU: 51}, // +1s
		{Pid: 13, Ppid: 10, CPU: 0.5},
		{Pid: 14, Ppid: 10, CPU: 0.5}, // 新起的
	})
	cur.At = t0.Add(4 * time.Second)
	// (2 + 1 + 0.5 + 0.5) / 4s = 100%（一个核）
	if got := cur.CPUSince(prev, cur.Subtree(10)); math.Abs(got-100) > 1e-9 {
		t.Fatalf("CPUSince = %v, want 100", got)
	}
	if got := cur.CPUSince(nil, cur.Subtree(10)); got != 0 {
		t.Fatalf("CPUSince(nil) = %v, want 0", got)
	}
	same := NewProcTable(nil)
	same.At = t0.Add(50 * time.Millisecond)
	if got := same.CPUSince(prev, nil); got != 0 {
		t.Fatalf("CPUSince over 50ms = %v, want 0", got)
	}
}
