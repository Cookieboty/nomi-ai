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
type LiveDeps struct {
	Platform  string
	Alive     func(pid float64) bool
	OpenFiles func(dir string) ([]float64, error)
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

func privateDir(kind, dir string) string {
	if kind == "gemini" {
		return filepath.Join(dir, ".gemini")
	}
	return dir
}

// LiveProcesses = liveProcesses（持 jsrt 锁调用）。
func LiveProcesses(kind, dir string, d LiveDeps) LiveCheck {
	alive := d.Alive
	if alive == nil {
		alive = PidAlive
	}
	if kind == "claude" {
		if pids := claudeSessionPids(dir, alive); len(pids) > 0 {
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
	if len(pids) > 0 {
		return LiveCheck{State: "busy", Pids: pids}
	}
	return LiveCheck{State: "idle"}
}
