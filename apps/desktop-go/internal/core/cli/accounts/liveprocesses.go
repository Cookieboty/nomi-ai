package accounts

import (
	"context"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// LiveCheck = LiveCheck（State busy / idle / unknown）。
type LiveCheck struct {
	State string
	Pids  []float64
}

// LiveDeps = LiveDeps（OpenFiles 持 jsrt 锁调用；nil 结果 = null）。
// Procs：本机进程表（nil 函数 / nil 结果 = 读不到，按原来的判断）。用来去掉 Nomi 自己的子进程
// （登录、额度读取、标签里的 CLI），以及会话文件残留、pid 已被别的程序复用的情况。
type LiveDeps struct {
	Platform  string
	Alive     func(pid float64) bool
	OpenFiles func(dir string) ([]float64, error)
	Procs     func() []ProcRow
	Self      float64 // 0 = os.Getpid()
}

// ProcRow：进程表一行（Ppid 0 = 不知道）。
type ProcRow struct {
	Pid, Ppid float64
	Name, Cmd string
}

// procIndex：进程表按 pid 索引；nil = 读不到
func procIndex(d LiveDeps) map[float64]ProcRow {
	if d.Procs == nil {
		return nil
	}
	rows := d.Procs()
	if rows == nil {
		return nil
	}
	m := make(map[float64]ProcRow, len(rows))
	for _, r := range rows {
		m[r.Pid] = r
	}
	return m
}

func selfPid(d LiveDeps) float64 {
	if d.Self > 0 {
		return d.Self
	}
	return float64(os.Getpid())
}

// nomiOwned：pid 是 Nomi 自己（或它拉起的子孙进程）：标签里的 CLI、登录 / 退出 / 额度读取用的 CLI。
// 这些由「标签在用」另外管（登录进程删除前会先取消），不算「Nomi 之外的进程」。
func nomiOwned(pid float64, procs map[float64]ProcRow, self float64) bool {
	cur := pid
	for i := 0; i < 64 && cur > 0; i++ {
		if cur == self {
			return true
		}
		r, ok := procs[cur]
		if !ok || r.Ppid == cur {
			return false
		}
		cur = r.Ppid
	}
	return false
}

// looksLikeCli：进程名或命令行里带着这个编程助手的名字（会话文件里的 pid 可能已经被别的程序复用）
func looksLikeCli(kind string, r ProcRow) bool {
	return strings.Contains(strings.ToLower(r.Name+" "+r.Cmd), strings.ToLower(kind))
}

// externalOnly：只留真正在 Nomi 之外、还活着的进程。fromSessions = pid 来自 Claude 的会话文件
// （进程退出时没删掉的文件会留下来，pid 之后可能被任何程序复用）。读不到进程表时原样返回。
func externalOnly(kind string, pids []float64, fromSessions bool, d LiveDeps) []float64 {
	procs := procIndex(d)
	if procs == nil {
		return pids
	}
	self := selfPid(d)
	out := []float64{}
	for _, p := range pids {
		r, ok := procs[p]
		if !ok || nomiOwned(p, procs, self) {
			continue
		}
		if fromSessions && !looksLikeCli(kind, r) {
			continue
		}
		out = append(out, p)
	}
	return out
}

const lsofTimeoutMs = 5_000

// PidAlive = pidAlive.
func PidAlive(pid float64) bool {
	if pid != math.Trunc(pid) || math.IsInf(pid, 0) {
		panic(typeErr(`The "pid" argument must be of type integer. Received ` + jsnum(pid)))
	}
	return pidAlive(int(pid))
}

func jsnum(f float64) string { return jsStr(f) }

var wsSplit = regexp.MustCompile(`\s+`)

func lsofPids(dir string) ([]float64, error) {
	p := jsrt.NewPromise[[]float64]()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), lsofTimeoutMs*time.Millisecond)
		defer cancel()
		cmd := exec.CommandContext(ctx, "lsof", "-n", "-P", "-t", "+d", dir)
		out, err := cmd.Output()
		if len(out) > 64*1024 {
			out = out[:64*1024]
		}
		var pids []float64
		for _, x := range wsSplit.Split(string(out), -1) {
			if x == "" {
				continue
			}
			n, perr := strconv.ParseFloat(x, 64)
			if perr == nil && n == math.Trunc(n) && n > 0 {
				pids = append(pids, n)
			}
		}
		if pids == nil {
			pids = []float64{}
		}
		if err != nil && (errors.Is(err, exec.ErrNotFound) || ctx.Err() != nil) {
			p.Resolve(nil)
			return
		}
		p.Resolve(pids)
	}()
	r, _ := jsrt.Await(p)
	return r, nil
}

var pidJSONRe = regexp.MustCompile(`^(\d+)\.json$`)

func claudeSessionPids(dir string, alive func(float64) bool) []float64 {
	sdir := filepath.Join(dir, "sessions")
	ents, err := os.ReadDir(sdir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	seen := map[float64]bool{}
	out := []float64{}
	self := float64(os.Getpid())
	for _, n := range names {
		m := pidJSONRe.FindStringSubmatch(n)
		if m == nil {
			continue
		}
		pid, _ := strconv.ParseFloat(m[1], 64)
		if b, err := os.ReadFile(filepath.Join(sdir, n)); err == nil {
			if v, err := parseJSON(string(b)); err == nil && !nullish(v) {
				if f, ok := prop(v, "pid").(float64); ok && f == math.Trunc(f) && !math.IsInf(f, 0) {
					pid = f
				}
			}
		}
		if pid > 0 && pid != self && alive(pid) && !seen[pid] {
			seen[pid] = true
			out = append(out, pid)
		}
	}
	return out
}

func privateDir(_, dir string) string { return dir }

// LiveProcesses = liveProcesses（持 jsrt 锁调用）。
func LiveProcesses(kind, dir string, d LiveDeps) LiveCheck {
	alive := d.Alive
	if alive == nil {
		alive = PidAlive
	}
	if kind == "claude" {
		if pids := externalOnly(kind, claudeSessionPids(dir, alive), true, d); len(pids) > 0 {
			return LiveCheck{State: "busy", Pids: pids}
		}
		return LiveCheck{State: "idle"}
	}
	platform := d.Platform
	if platform == "" {
		platform = usage.Platform()
	}
	if d.OpenFiles == nil && platform == "win32" {
		return LiveCheck{State: "unknown"}
	}
	target := privateDir(kind, dir)
	if !usage.ExistsSync(target) {
		return LiveCheck{State: "idle"}
	}
	of := d.OpenFiles
	if of == nil {
		of = lsofPids
	}
	var open []float64
	func() {
		defer func() {
			if r := recover(); r != nil {
				if _, ok := r.(jsrt.JSThrow); !ok {
					panic(r)
				}
				open = nil
			}
		}()
		o, err := of(target)
		if err == nil {
			open = o
		}
	}()
	if open == nil {
		return LiveCheck{State: "unknown"}
	}
	seen := map[float64]bool{}
	pids := []float64{}
	self := float64(os.Getpid())
	for _, p := range open {
		if seen[p] {
			continue
		}
		seen[p] = true
		if p != self {
			pids = append(pids, p)
		}
	}
	pids = externalOnly(kind, pids, false, d)
	if len(pids) > 0 {
		return LiveCheck{State: "busy", Pids: pids}
	}
	return LiveCheck{State: "idle"}
}
