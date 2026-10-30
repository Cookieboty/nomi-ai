package gwstore

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
)

// 模型目录同步的时序（#185，对齐 core gatewayService.test.ts 的 models data sync ordering）：
// 落盘成功后才生效、推配置；网关收到配置时按 catalogFile 读到的就是这次同步的目录。

// catalogChild：假网关，收到配置时像 worker 一样按 catalogFile 读磁盘，记下读到的条目数（0 = 没有目录）
type catalogChild struct {
	mu   sync.Mutex
	seen []int
}

func (c *catalogChild) PostMessage(m server.WorkerInbound) {
	if m.Type != "config" || m.Config == nil {
		return
	}
	n := 0
	if m.Config.CatalogFile != "" {
		if doc := models.ReadCatalogFile(m.Config.CatalogFile); doc != nil {
			n = len(doc.Models.Keys())
		}
	}
	c.mu.Lock()
	c.seen = append(c.seen, n)
	c.mu.Unlock()
}
func (c *catalogChild) OnMessage(func(server.WorkerOutbound)) {}
func (c *catalogChild) OnExit(func(int))                      {}
func (c *catalogChild) Kill() bool                            { return true }

func (c *catalogChild) snapshot() []int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]int(nil), c.seen...)
}

// pendingWrite：挂起的一次写，测试决定落盘（nil）还是失败
type pendingWrite struct {
	file string
	data []byte
	res  chan error
}

type catalogFixture struct {
	s          *Service
	child      *catalogChild
	writes     chan pendingWrite
	file       string
	bmu        sync.Mutex
	broadcasts int
	warnings   *[]string
}

func newCatalogFixture(t *testing.T, delayed bool) *catalogFixture {
	t.Helper()
	models.SetCatalogOverlay(nil)
	t.Cleanup(func() { models.SetCatalogOverlay(nil) })
	root := filepath.Join(t.TempDir(), "gateway")
	f := &catalogFixture{child: &catalogChild{}, writes: make(chan pendingWrite, 4), file: filepath.Join(root, "catalog-sync.json")}
	warnings := []string{}
	f.warnings = &warnings
	var wmu sync.Mutex
	logger := &recordLogger{warn: func(msg string) { wmu.Lock(); warnings = append(warnings, msg); wmu.Unlock() }}
	f.s = NewService(root, fakeCipher{}, logger, nil)
	port := 18721
	deps := RuntimeDeps{
		Root: root, Port: &port, Lazy: true, Env: map[string]string{},
		Fork: func() GatewayChild { return f.child },
		Broadcast: func(string, any) {
			f.bmu.Lock()
			f.broadcasts++
			f.bmu.Unlock()
		},
	}
	if delayed {
		deps.WriteCatalog = func(file string, data []byte) error {
			w := pendingWrite{file: file, data: data, res: make(chan error, 1)}
			f.writes <- w
			return <-w.res
		}
	}
	f.s.AttachRuntime(deps)
	if err := f.s.Init(); err != nil {
		t.Fatal(err)
	}
	f.s.Start()
	f.s.EnsureStarted()
	t.Cleanup(f.s.Dispose)
	return f
}

func (f *catalogFixture) nextWrite(t *testing.T) pendingWrite {
	t.Helper()
	select {
	case w := <-f.writes:
		return w
	case <-time.After(5 * time.Second):
		t.Fatal("no catalog write started")
		return pendingWrite{}
	}
}

func (w pendingWrite) land(t *testing.T) {
	t.Helper()
	if err := os.WriteFile(w.file, w.data, 0o600); err != nil {
		t.Fatal(err)
	}
	w.res <- nil
}

func (f *catalogFixture) broadcastCount() int {
	f.bmu.Lock()
	defer f.bmu.Unlock()
	return f.broadcasts
}

func wait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ApplyModelsData did not finish")
	}
}

// mainSize：主进程覆盖层的条目数（151 = catalogAPI(150)，161 = catalogAPI(160)；内置目录里没有 m-150…）
func mainSize() int {
	switch {
	case models.CatalogEntry("m-155") != nil:
		return 161
	case models.CatalogEntry("m-149") != nil:
		return 151
	}
	return 0
}

// recordLogger：只记 warn 的消息
type recordLogger struct{ warn func(string) }

func (l *recordLogger) Info(string, any)       {}
func (l *recordLogger) Warn(msg string, _ any) { l.warn(msg) }

// catalogAPI(n)：n 个模型（+ plain），目录条目数 = n + 1
func catalogAPI(n int) any { return cliModelsAPI(n) }

func TestCatalogSyncPushesOnlyAfterTheWriteLanded(t *testing.T) {
	f := newCatalogFixture(t, true)
	before := len(f.child.snapshot())
	if before == 0 {
		t.Fatal("gateway child got no config")
	}
	b0 := f.broadcastCount()
	done := f.s.ApplyModelsData(catalogAPI(150))
	w := f.nextWrite(t)
	// 写还没完成：不生效、不推配置、不通知界面
	if got := len(f.child.snapshot()); got != before || f.broadcastCount() != b0 || f.s.HasCatalogSync() {
		t.Fatalf("announced before the write landed: seen=%d broadcasts=%d synced=%v", got, f.broadcastCount()-b0, f.s.HasCatalogSync())
	}
	w.land(t)
	wait(t, done)
	seen := f.child.snapshot()
	if len(seen) != before+1 || seen[len(seen)-1] != 151 {
		t.Fatalf("worker did not see the new catalog: %v", seen)
	}
	if f.broadcastCount() != b0+1 || !f.s.HasCatalogSync() {
		t.Fatal("not applied after the write")
	}

	// 更新已有目录：落盘前主进程与网关都还是旧目录
	done = f.s.ApplyModelsData(catalogAPI(160))
	w = f.nextWrite(t)
	if mainSize() != 151 {
		t.Fatalf("main switched before the write: %d", mainSize())
	}
	w.land(t)
	wait(t, done)
	if seen := f.child.snapshot(); seen[len(seen)-1] != 161 || mainSize() != 161 {
		t.Fatalf("update not seen: %v main=%d", seen, mainSize())
	}
}

func TestCatalogSyncWriteFailureAnnouncesNothing(t *testing.T) {
	f := newCatalogFixture(t, true)
	before := len(f.child.snapshot())
	b0 := f.broadcastCount()
	done := f.s.ApplyModelsData(catalogAPI(150))
	w := f.nextWrite(t)
	w.res <- errors.New("EBUSY")
	wait(t, done)
	if len(f.child.snapshot()) != before || f.broadcastCount() != b0 {
		t.Fatal("pushed or announced after a failed write")
	}
	// 没同步成功：下次仍强制完整下载
	if f.s.HasCatalogSync() {
		t.Fatal("catalog applied although the write failed")
	}
	if _, err := os.Stat(f.file); !os.IsNotExist(err) {
		t.Fatalf("catalog file exists: %v", err)
	}
	found := false
	for _, m := range *f.warnings {
		found = found || m == "models catalog write failed"
	}
	if !found {
		t.Fatalf("warnings %q", *f.warnings)
	}
}

func TestCatalogSyncConcurrentLaterWins(t *testing.T) {
	f := newCatalogFixture(t, true)
	a := f.s.ApplyModelsData(catalogAPI(150))
	wa := f.nextWrite(t)
	b := f.s.ApplyModelsData(catalogAPI(160))
	// 前一次落盘并生效，后一次随后落盘覆盖
	wa.land(t)
	wait(t, a)
	wb := f.nextWrite(t)
	wb.land(t)
	wait(t, b)
	seen := f.child.snapshot()
	if seen[len(seen)-1] != 161 || mainSize() != 161 {
		t.Fatalf("later sync lost: %v main=%d", seen, mainSize())
	}
}

func TestCatalogSyncStaleSyncIsSkipped(t *testing.T) {
	f := newCatalogFixture(t, false)
	// goroutine 不保证先来先写：后一次（序号 5）已落盘时，前一次（序号 3）不再写也不再生效
	f.s.rt.catalogDone = 5
	before := len(f.child.snapshot())
	wrote := false
	doc := models.BuildCatalog(catalogAPI(150), "2026-11-01").CatalogDoc
	if f.s.writeCatalog(3, func(string, []byte) error { wrote = true; return nil }, f.file, &doc, []byte("{}")) {
		t.Fatal("stale sync reported as applied")
	}
	if wrote || len(f.child.snapshot()) != before || f.s.HasCatalogSync() {
		t.Fatal("stale sync wrote or pushed")
	}
}

func TestCatalogSyncRealWriterConcurrent(t *testing.T) {
	f := newCatalogFixture(t, false)
	a := f.s.ApplyModelsData(catalogAPI(150))
	b := f.s.ApplyModelsData(catalogAPI(160))
	wait(t, a)
	wait(t, b)
	if n := len(models.ReadCatalogFile(f.file).Models.Keys()); n != 161 || mainSize() != 161 {
		t.Fatalf("disk=%d main=%d", n, mainSize())
	}
	if seen := f.child.snapshot(); seen[len(seen)-1] != 161 {
		t.Fatalf("worker saw %v", seen)
	}
}

func TestCatalogSyncAfterDisposeDoesNotRestart(t *testing.T) {
	f := newCatalogFixture(t, true)
	done := f.s.ApplyModelsData(catalogAPI(150))
	w := f.nextWrite(t)
	f.s.Dispose()
	before := len(f.child.snapshot())
	w.land(t)
	wait(t, done)
	if len(f.child.snapshot()) != before {
		t.Fatal("pushed config after dispose")
	}
}
