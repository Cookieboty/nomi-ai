package diagnostics

// cliTrace.ts 的 1:1 移植：编程助手子进程原始收发写到 logs/cli-YYYY-MM-DD.jsonl（诊断日志开着时）。
// 每条记录当场脱敏（redactText）、截断（64K 码元）、计入当日大小（200MB 上限，超了留一行说明并停写）；
// 进内存队列，攒 200ms 或 256KB 后异步追加（0600），同一时间一次写入，顺序与产生顺序一致。

import (
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

const (
	maxDayBytes   = 200 * 1024 * 1024
	maxChunkChars = 64 * 1024
	traceFlush    = 200 * time.Millisecond
	traceFlushB   = 256 * 1024
)

type pendingLine struct{ file, line string }

type CliTrace struct {
	dir      string
	enabled  func() bool
	Now      func() time.Time
	mu       sync.Mutex
	day      string
	written  int
	capped   bool
	pending  []pendingLine
	pendB    int
	writing  chan struct{}
	timer    *time.Timer
	readyDir string
}

func NewCliTrace(dir string, enabled func() bool) *CliTrace {
	return &CliTrace{dir: dir, enabled: enabled, Now: time.Now}
}

func traceText(s string) string {
	if util.UTF16Len(s) > maxChunkChars {
		s = util.UTF16Slice0(s, maxChunkChars) + "…[truncated]"
	}
	return server.RedactText(s, nil)
}

// file：持锁
func (t *CliTrace) file(now time.Time) string {
	d := now.UTC().Format("2006-01-02")
	f := filepath.Join(t.dir, "cli-"+d+".jsonl")
	if d != t.day {
		t.day = d
		t.capped = false
		if st, err := os.Stat(f); err == nil {
			t.written = int(st.Size())
		} else {
			t.written = 0
		}
	}
	return f
}

func (t *CliTrace) ensureDir(f string) error {
	d := filepath.Dir(f)
	if t.readyDir == d {
		return nil
	}
	if err := os.MkdirAll(d, 0o777); err != nil {
		return err
	}
	t.readyDir = d
	return nil
}

func (t *CliTrace) scheduleFlush(d time.Duration) {
	if t.timer != nil {
		if d > 0 {
			return
		}
		t.timer.Stop()
	}
	t.timer = time.AfterFunc(d, func() {
		t.mu.Lock()
		t.timer = nil
		t.mu.Unlock()
		t.Flush()
	})
}

func (t *CliTrace) takeBatches() []pendingLine {
	var out []pendingLine
	for _, p := range t.pending {
		if n := len(out); n > 0 && out[n-1].file == p.file {
			out[n-1].line += p.line
		} else {
			out = append(out, p)
		}
	}
	t.pending = nil
	t.pendB = 0
	return out
}

func appendPrivate(f, s string) error {
	h, err := os.OpenFile(f, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = h.WriteString(s)
	if c := h.Close(); err == nil {
		err = c
	}
	return err
}

func (t *CliTrace) appendBatch(b pendingLine) error {
	t.mu.Lock()
	err := t.ensureDir(b.file)
	t.mu.Unlock()
	if err == nil {
		err = appendPrivate(b.file, b.line)
	}
	if err != nil && os.IsNotExist(err) {
		t.mu.Lock()
		t.readyDir = ""
		err = t.ensureDir(b.file)
		t.mu.Unlock()
		if err == nil {
			err = appendPrivate(b.file, b.line)
		}
	}
	return err
}

// Flush：写出当前缓冲；返回时已入队的记录全部落盘（或写失败被丢弃）
func (t *CliTrace) Flush() {
	for {
		t.mu.Lock()
		if t.timer != nil {
			t.timer.Stop()
			t.timer = nil
		}
		if w := t.writing; w != nil {
			t.mu.Unlock()
			<-w
			continue
		}
		if len(t.pending) == 0 {
			t.mu.Unlock()
			return
		}
		batches := t.takeBatches()
		done := make(chan struct{})
		t.writing = done
		t.mu.Unlock()
		for _, b := range batches {
			_ = t.appendBatch(b) // 诊断日志写不了不能影响编程助手
		}
		t.mu.Lock()
		t.writing = nil
		close(done)
		if len(t.pending) > 0 {
			t.scheduleFlush(0)
		}
		t.mu.Unlock()
		return
	}
}

// FlushSync = flushSync / dispose（进程退出、内核停止）
func (t *CliTrace) FlushSync() { t.Flush() }

func (t *CliTrace) write(rec *util.Obj) {
	if !t.enabled() {
		return
	}
	now := t.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	f := t.file(now)
	if t.capped {
		return
	}
	ts := now.UTC().Format("2006-01-02T15:04:05.000Z")
	o := util.NewObj("t", ts)
	for _, k := range rec.Keys() {
		o.Set(k, rec.Get(k))
	}
	line := util.Stringify(o) + "\n"
	if t.written+util.UTF16Len(line) > maxDayBytes {
		t.capped = true
		line = util.Stringify(util.NewObj("t", ts, "note", "daily size limit reached, stop logging")) + "\n"
	}
	n := util.UTF16Len(line)
	t.written += n
	t.pending = append(t.pending, pendingLine{f, line})
	t.pendB += n
	if t.pendB >= traceFlushB {
		t.scheduleFlush(0)
	} else {
		t.scheduleFlush(traceFlush)
	}
}

// Tap = tap(child, command, args, { tabId })
func (t *CliTrace) Tap(child clisdk.ChildLike, command string, args []string, tabID string) {
	if !t.enabled() {
		return
	}
	cli := filepath.Base(command)
	pid := child.PID()
	rec := func(kv ...any) {
		o := util.NewObj()
		if pid != 0 {
			o.Set("pid", float64(pid))
		}
		o.Set("cli", cli)
		if tabID != "" {
			o.Set("tab", tabID)
		}
		for i := 0; i+1 < len(kv); i += 2 {
			o.Set(kv[i].(string), kv[i+1])
		}
		t.write(o)
	}
	ra := make([]any, len(args))
	for i, a := range args {
		ra[i] = server.RedactText(a, nil)
	}
	rec("ev", "spawn", "args", ra)
	if s, ok := child.Stdin().(*nodeproc.Stdin); ok && s != nil {
		prev := s.OnWrite
		s.OnWrite = func(c string) {
			rec("ev", "in", "data", traceText(c))
			if prev != nil {
				prev(c)
			}
		}
	}
	child.OnStdout(func(c string) { rec("ev", "out", "data", traceText(c)) })
	child.OnStderr(func(c string) { rec("ev", "err", "data", traceText(c)) })
	child.OnClose(func(code *int, signal string) {
		var c, sg any
		if code != nil {
			c = float64(*code)
		}
		if signal != "" {
			sg = signal
		}
		rec("ev", "exit", "code", c, "signal", sg)
	})
}
