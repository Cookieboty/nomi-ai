package agents

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 原生读法与 ps 对得上：自己这个进程的父进程、名字、命令行、内存与 CPU 都在；整体进程数相近
func TestNativeProcessesMatchPs(t *testing.T) {
	native := readProcessesNative()
	if native == nil {
		t.Skip("no native process reader on this platform / build")
	}
	if runtime.GOOS == "windows" {
		t.Skip("compared against ps; Windows is covered by TestNativeProcessesSelf")
	}
	if _, err := exec.LookPath("ps"); err != nil {
		t.Skip("no ps")
	}
	so, err := runCmd(4*time.Second, "ps", psArgs...)
	if err != nil {
		t.Fatal(err)
	}
	ps := ParsePs(so)
	byPid := map[float64]RawProc{}
	for _, p := range ps {
		byPid[p.Pid] = p
	}
	self := float64(os.Getpid())
	var me *RawProc
	for i := range native {
		if native[i].Pid == self {
			me = &native[i]
		}
	}
	if me == nil {
		t.Fatal("own process missing")
	}
	want := byPid[self]
	if me.Ppid != want.Ppid || me.Cmd != want.Cmd {
		t.Fatalf("self: native %+v, ps %+v", *me, want)
	}
	if !strings.Contains(me.Cmd, os.Args[0]) || me.RSS <= 0 || me.CPU <= 0 {
		t.Fatalf("self fields: %+v", *me)
	}
	// 认出的编程助手进程一样（两次采样之间进程可能起落，只比较两边都有的 pid）
	agentPids := func(procs []RawProc) map[float64]bool {
		m := map[float64]bool{}
		for _, a := range Classify(procs, self) {
			m[a.Pid] = true
		}
		return m
	}
	an, ap := agentPids(native), agentPids(ps)
	for pid := range ap {
		if _, alive := byPid[pid]; alive && !an[pid] {
			if _, inNative := func() (RawProc, bool) {
				for _, p := range native {
					if p.Pid == pid {
						return p, true
					}
				}
				return RawProc{}, false
			}(); inNative {
				t.Fatalf("agent %v found by ps but not natively", pid)
			}
		}
	}
	// 采样时刻不同，进程数允许有出入
	if d := len(native) - len(ps); d > 20 || d < -20 {
		t.Fatalf("process count: native %d, ps %d", len(native), len(ps))
	}
}

func TestNativeProcessesSelf(t *testing.T) {
	native := readProcessesNative()
	if native == nil {
		t.Skip("no native process reader on this platform / build")
	}
	for _, p := range native {
		if p.Pid == float64(os.Getpid()) {
			if p.Ppid <= 0 || p.Name == "" || p.Cmd == "" || p.RSS <= 0 {
				t.Fatalf("self: %+v", p)
			}
			return
		}
	}
	t.Fatal("own process missing")
}
