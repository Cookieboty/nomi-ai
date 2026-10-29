package usage

// 对应 packages/core/src/usage/GatewayRequestLog.ts：网关正文追踪目录、过期清理、旧 requests.json 迁移。

import (
	"os"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
	"path/filepath"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/quality"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type GatewayRequestLogDeps struct {
	Root   string
	Logger Logger
	// TraceOn：正文追踪是否开着（诊断日志开关）
	TraceOn func() bool
	// ImportLegacy：旧 requests.json 的条目导入模型质量账本；返回 error = JS 抛错
	ImportLegacy func(records []*util.Obj) error
	Now          func() float64
	// PruneMs：nil = 1 小时；<=0 = 不定时清理
	PruneMs *float64
}

const (
	grlRequestsFile = "requests.json"
	grlObserveFile  = "observe.json"
	grlTraceDir     = "trace"
)

type GatewayRequestLog struct {
	d    GatewayRequestLogDeps
	mu   sync.Mutex
	stop chan struct{}
}

// Legacy：转成 quality.RecordFromEntry 的输入
func (e *GatewayRequestEntry) Legacy() quality.LegacyEntry {
	return quality.LegacyEntry{ID: e.ID, Client: e.Client, Ingress: e.Ingress, Wire: e.Wire, ProviderID: e.ProviderID, KeyID: e.KeyID,
		Model: e.Model, Error: e.Error, TraceID: e.TraceID, TabID: e.TabID, Resolved: e.Resolved, TS: e.TS, Status: e.Status, Ms: e.Ms,
		Input: e.Input, Output: e.Output, CacheRead: e.CacheRead, CacheWrite: e.CacheWrite, Reasoning: e.Reasoning,
		Generation: e.Generation, FirstByteMs: e.FirstByteMs, Notes: e.Notes}
}

func NewGatewayRequestLog(d GatewayRequestLogDeps) *GatewayRequestLog {
	l := &GatewayRequestLog{d: d}
	l.migrateLegacy()
	l.Prune()
	every := 60 * 60 * 1000.0
	if d.PruneMs != nil {
		every = *d.PruneMs
	}
	if every > 0 {
		l.stop = make(chan struct{})
		tk := time.NewTicker(time.Duration(every * float64(time.Millisecond)))
		go func(stop chan struct{}) {
			defer tk.Stop()
			for {
				select {
				case <-tk.C:
					l.Prune()
				case <-stop:
					return
				}
			}
		}(l.stop)
	}
	return l
}

// migrateLegacy：导入质量账本成功后再删除；读不懂 / 写入失败的文件留着（#127）
func (l *GatewayRequestLog) migrateLegacy() {
	file := filepath.Join(l.d.Root, grlRequestsFile)
	if l.d.ImportLegacy == nil {
		return
	}
	if _, err := os.Stat(file); err != nil {
		return
	}
	// warn 文本 = Node 的 (e as Error).message
	fail := func(msg string) {
		if l.d.Logger != nil {
			l.d.Logger.Warn("gateway request log migration failed", map[string]any{"error": msg})
		}
	}
	b, err := os.ReadFile(file)
	if err != nil {
		fail(nodefs.ReadFileError(err, file))
		return
	}
	raw, err := util.Parse(b)
	if err != nil {
		// JSON.parse 的 SyntaxError.message（V8 文本）
		msg := err.Error()
		if _, e2 := charcontract.ParseJSON(strings.ToValidUTF8(string(b), "\uFFFD")); e2 != nil {
			msg = e2.Error()
		}
		fail(msg)
		return
	}
	var reqs any
	if o, ok := raw.(*util.Obj); ok {
		reqs = o.Get("requests")
	}
	entries := SanitizeEntries(reqs)
	if len(entries) > 0 {
		recs := make([]*util.Obj, len(entries))
		for i, e := range entries {
			recs[i] = quality.RecordFromEntry(e.Legacy())
		}
		if err := l.d.ImportLegacy(recs); err != nil {
			fail(err.Error())
			return
		}
	}
	if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
		fail(nodefs.Message(err, "unlink", file))
	}
}

func (l *GatewayRequestLog) traceDirPath() string { return filepath.Join(l.d.Root, grlTraceDir) }

// TraceDir：追踪开着时的目录；关着返回 ""（undefined）
func (l *GatewayRequestLog) TraceDir() string {
	if l.d.TraceOn != nil && l.d.TraceOn() {
		return l.traceDirPath()
	}
	return ""
}

func (l *GatewayRequestLog) TraceStateChanged() { l.Prune() }

// Prune：删除超过 24 小时的追踪文件
func (l *GatewayRequestLog) Prune() int {
	now := float64(time.Now().UnixMilli())
	if l.d.Now != nil {
		now = l.d.Now()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return server.PruneTraces(l.traceDirPath(), now, server.TraceMaxAgeMs)
}

func (l *GatewayRequestLog) Dispose() {
	if l.stop != nil {
		close(l.stop)
	}
	l.stop = nil
}

// ReadLegacyGatewayTrace：旧版「调试模式」开关（observe.json 的 trace === true）
func ReadLegacyGatewayTrace(root string) bool {
	b, err := os.ReadFile(filepath.Join(root, grlObserveFile))
	if err != nil {
		return false
	}
	raw, err := util.Parse(b)
	if err != nil {
		return false
	}
	o, ok := raw.(*util.Obj)
	if !ok {
		return false
	}
	t, ok := o.Get("trace").(bool)
	return ok && t
}
