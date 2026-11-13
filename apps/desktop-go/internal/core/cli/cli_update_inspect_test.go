package cli

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type inspectEvents struct {
	mu       sync.Mutex
	payloads []*util.Obj
}

func (e *inspectEvents) Publish(_ string, payload any) {
	if o, ok := payload.(*util.Obj); ok {
		e.mu.Lock()
		e.payloads = append(e.payloads, o)
		e.mu.Unlock()
	}
}

type inspectLog struct {
	mu   sync.Mutex
	info []string
	warn []string
}

func (l *inspectLog) Info(m string, d any) {
	l.mu.Lock()
	l.info = append(l.info, m+" "+fmt.Sprint(d))
	l.mu.Unlock()
}

func (l *inspectLog) Warn(m string, d any) {
	l.mu.Lock()
	l.warn = append(l.warn, m+" "+fmt.Sprint(d))
	l.mu.Unlock()
}

func (l *inspectLog) warns() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, len(l.warn))
	copy(out, l.warn)
	return out
}

func (l *inspectLog) infos() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, len(l.info))
	copy(out, l.info)
	return out
}

func (e *inspectEvents) all() []*util.Obj {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]*util.Obj, len(e.payloads))
	copy(out, e.payloads)
	return out
}

func stubInspectBins(t *testing.T, bins map[string]string, versions map[string]string) {
	t.Helper()
	prevBin, prevVer, prevFetch, prevTo := resolveInspectBin, readInspectVersion, fetchNpmLatest, inspectTimeout
	resolveInspectBin = func(kind string) string { return bins[kind] }
	readInspectVersion = func(bin string) string { return versions[bin] }
	t.Cleanup(func() {
		resolveInspectBin, readInspectVersion, fetchNpmLatest, inspectTimeout = prevBin, prevVer, prevFetch, prevTo
	})
}

func runInspect(t *testing.T, s *CliUpdateService, refresh bool) []*util.Obj {
	t.Helper()
	var rows []*util.Obj
	var err error
	p := jsrt.Call(func() *jsrt.Promise[[]*util.Obj] { return s.Inspect(refresh) })
	rows, err = jsrt.Block(p)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	return rows
}

func rowByKind(t *testing.T, rows []*util.Obj, kind string) *util.Obj {
	t.Helper()
	for _, r := range rows {
		if r.Get("kind") == kind {
			return r
		}
	}
	t.Fatalf("missing kind %s", kind)
	return nil
}

func TestInspectReturnsLocalWithoutWaitingForNpm(t *testing.T) {
	stubInspectBins(t, map[string]string{"claude": "/usr/bin/claude"}, map[string]string{"/usr/bin/claude": "2.1.0"})
	started := make(chan struct{})
	release := make(chan struct{})
	var startOnce sync.Once
	fetchNpmLatest = func(string, int) string {
		startOnce.Do(func() { close(started) })
		<-release
		return "9.9.9"
	}
	t.Cleanup(func() { close(release) })

	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	rows := runInspect(t, s, false)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("inspect waited for npm: %s", elapsed)
	}
	claude := rowByKind(t, rows, "claude")
	if claude.Get("path") != "/usr/bin/claude" || claude.Get("version") != "2.1.0" {
		t.Fatalf("local probe: %#v", claude)
	}
	if claude.Get("latest") != nil {
		t.Fatalf("cold cache should not wait for latest, got %v", claude.Get("latest"))
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("expected background npm refresh to start")
	}
}

func TestInspectIncludesWarmLatestCache(t *testing.T) {
	stubInspectBins(t, map[string]string{"codex": "/usr/bin/codex"}, map[string]string{"/usr/bin/codex": "0.16.0"})
	fetchNpmLatest = func(string, int) string {
		t.Fatal("warm cache should not fetch npm on inspect(false)")
		return ""
	}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	latest := util.NewObj()
	for _, k := range latestKinds {
		latest.Set(k, "1.0.0")
	}
	latest.Set("codex", "0.17.0")
	s.cache = util.NewObj("checkedAt", cuNow(), "latest", latest)

	rows := runInspect(t, s, false)
	codex := rowByKind(t, rows, "codex")
	if codex.Get("latest") != "0.17.0" {
		t.Fatalf("expected cached latest, got %v", codex.Get("latest"))
	}
	if codex.Get("updateAvailable") != true {
		t.Fatalf("expected updateAvailable, got %v", codex.Get("updateAvailable"))
	}
}

func TestInspectEmitsUpdatedWhenLatestArrives(t *testing.T) {
	stubInspectBins(t, map[string]string{"claude": "/usr/bin/claude"}, map[string]string{"/usr/bin/claude": "2.1.0"})
	release := make(chan struct{})
	fetchNpmLatest = func(pkg string, _ int) string {
		<-release
		if pkg == NpmPkg["claude"] {
			return "2.2.0"
		}
		return "1.0.0"
	}
	ev := &inspectEvents{}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir(), Events: ev})
	if err != nil {
		t.Fatal(err)
	}
	rows := runInspect(t, s, true)
	if rowByKind(t, rows, "claude").Get("latest") != nil {
		t.Fatal("should return before npm")
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("did not receive inspect updated event")
		}
		var found *util.Obj
		for _, p := range ev.all() {
			if p.Get("kind") == "inspect" && p.Get("phase") == "updated" {
				found = p
				break
			}
		}
		if found != nil {
			raw, _ := found.Get("rows").([]any)
			var claude *util.Obj
			for _, item := range raw {
				if o, ok := item.(*util.Obj); ok && o.Get("kind") == "claude" {
					claude = o
				}
			}
			if claude == nil || claude.Get("latest") != "2.2.0" {
				t.Fatalf("updated event missing latest: %#v", found)
			}
			if claude.Get("updateAvailable") != true {
				t.Fatalf("expected updateAvailable after latest, got %v", claude.Get("updateAvailable"))
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestInspectTimesOutInsteadOfHanging(t *testing.T) {
	stubInspectBins(t, nil, nil)
	block := make(chan struct{})
	resolveInspectBin = func(string) string { <-block; return "" }
	inspectTimeout = 80 * time.Millisecond
	t.Cleanup(func() { close(block) })
	lg := &inspectLog{}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir(), Logger: lg})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	rows := runInspect(t, s, false)
	elapsed := time.Since(start)
	if elapsed > time.Second {
		t.Fatalf("timeout did not unstick inspect: %s", elapsed)
	}
	if len(rows) != len(inspectKinds) {
		t.Fatalf("got %d rows, want %d", len(rows), len(inspectKinds))
	}
	if rowByKind(t, rows, "claude").Get("path") != nil {
		t.Fatalf("fallback rows should have null path")
	}
	found := false
	for _, w := range lg.warns() {
		if strings.Contains(w, "cli-update inspect timed out") && strings.Contains(w, "fallback=empty") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected timeout log with empty fallback, got %q", lg.warns())
	}
}

// Inspect 必须在有人长时间占着 GIL 时仍能探到 plan/rows，
// 避免启动期其它 jsrt 工作把 inspectInner 卡到 20s 超时（无 plan 日志）。
func TestInspectProgressesWhileGILHeld(t *testing.T) {
	stubInspectBins(t, map[string]string{"claude": "/usr/bin/claude"}, map[string]string{"/usr/bin/claude": "2.1.0"})
	lg := &inspectLog{}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir(), Logger: lg})
	if err != nil {
		t.Fatal(err)
	}
	p := jsrt.Call(func() *jsrt.Promise[[]*util.Obj] { return s.Inspect(false) })

	holding := make(chan struct{})
	release := make(chan struct{})
	go jsrt.Run(func() {
		close(holding)
		<-release
	})
	<-holding

	start := time.Now()
	rows, err := jsrt.Block(p)
	elapsed := time.Since(start)
	close(release)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("inspect blocked on GIL holder: %s", elapsed)
	}
	if rowByKind(t, rows, "claude").Get("path") != "/usr/bin/claude" {
		t.Fatalf("rows=%v", rows)
	}
	var planned bool
	for _, line := range lg.infos() {
		if strings.Contains(line, "cli-update inspect plan") {
			planned = true
			break
		}
	}
	if !planned {
		t.Fatalf("expected plan log while GIL held, info=%q warn=%q", lg.infos(), lg.warns())
	}
}

// 完成更新会清空探测缓存；在计划与后续处理之间完成更新，不能让 inspect 读到 nil。
type inspectPlanLogger struct {
	once   sync.Once
	onPlan func()
}

func (l *inspectPlanLogger) Info(msg string, _ any) {
	if msg == "cli-update inspect plan" {
		l.once.Do(l.onPlan)
	}
}
func (*inspectPlanLogger) Warn(string, any) {}

func TestInspectKeepsProbeSnapshotWhenUpdateFinishes(t *testing.T) {
	stubInspectBins(t, map[string]string{"codex": "/usr/bin/codex"}, map[string]string{"/usr/bin/codex": "2.0.0"})
	logger := &inspectPlanLogger{}
	s, err := NewCliUpdateService(CliUpdateOptions{Root: t.TempDir(), Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	latest := util.NewObj()
	for _, kind := range latestKinds {
		latest.Set(kind, "2.0.0")
	}
	s.cache = util.NewObj("checkedAt", cuNow(), "latest", latest)
	s.probed = &probedEntry{at: cuNow(), rows: jsrt.Resolved([]localProbe{{kind: "codex", bin: "/usr/bin/codex", version: "1.0.0"}})}
	s.jobs["codex"] = &cliJob{kind: "codex", status: "running"}
	logger.onPlan = func() {
		// 精确重现 finishJob 与后台 inspect 交错，不靠 sleep 或调度概率。
		jsrt.Run(func() { s.finishJob("codex", cuResult(true, "", "2.0.0")) })
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("inspect panicked after update invalidated its probe: %v", r)
		}
	}()
	rows, err := s.inspectInner(false)
	if err != nil {
		t.Fatal(err)
	}
	if got := rowByKind(t, rows, "codex").Get("version"); got != "1.0.0" {
		t.Fatalf("in-flight inspect version = %v, want its cached snapshot 1.0.0", got)
	}
	s.mu.Lock()
	invalidated := s.probed == nil
	s.mu.Unlock()
	if !invalidated {
		t.Fatal("in-flight inspect restored the cache invalidated by finishJob")
	}
	// 当前调用可以交付原快照，但下一次调用必须重探测，不能继续使用更新前的版本。
	rows = runInspect(t, s, false)
	if got := rowByKind(t, rows, "codex").Get("version"); got != "2.0.0" {
		t.Fatalf("next inspect version = %v, want fresh probe 2.0.0", got)
	}
}
