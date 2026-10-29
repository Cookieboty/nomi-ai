package utils

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Produce = coalescedWriter.ts Produce：写入时才生成内容。
type Produce func() (string, error)

var (
	liveMu      sync.Mutex
	liveWriters = map[*FileWriter]struct{}{}
)

type inflightWrite struct {
	data string
	g    int
}

// FileWriter = utils/coalescedWriter.ts CoalescedWriter（按文件去抖、合并、原子写）。
// 与 Node 一样只在 jsrt 线程上调用；异步写在 goroutine 里做，rename 前按代次判断是否已被更新的写覆盖。
type FileWriter struct {
	mu       sync.Mutex
	delay    time.Duration
	onError  func(file string, err error)
	pending  map[string]Produce
	order    []string
	inflight map[string]inflightWrite
	gen      map[string]int
	timer    *jsrt.Timer
	chain    chan struct{}
	seq      int
}

// NewFileWriter：delayMs <= 0 用 200。
func NewFileWriter(delayMs int, onError func(string, error)) *FileWriter {
	if delayMs <= 0 {
		delayMs = 200
	}
	if onError == nil {
		onError = func(string, error) {}
	}
	done := make(chan struct{})
	close(done)
	w := &FileWriter{delay: time.Duration(delayMs) * time.Millisecond, onError: onError,
		pending: map[string]Produce{}, inflight: map[string]inflightWrite{}, gen: map[string]int{}, chain: done}
	liveMu.Lock()
	liveWriters[w] = struct{}{}
	liveMu.Unlock()
	return w
}

func (w *FileWriter) Schedule(file string, produce Produce) {
	w.mu.Lock()
	if _, ok := w.pending[file]; !ok {
		w.order = append(w.order, file)
	}
	w.pending[file] = produce
	armed := w.timer != nil
	w.mu.Unlock()
	if armed {
		return
	}
	t := jsrt.SetTimeout(w.delay, func() {
		w.mu.Lock()
		w.timer = nil
		w.mu.Unlock()
		w.Flush()
	})
	w.mu.Lock()
	w.timer = t
	w.mu.Unlock()
}

// Cancel drops a pending write (e.g. the file is about to be deleted).
func (w *FileWriter) Cancel(file string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.pending[file]; ok {
		delete(w.pending, file)
		w.order = removeStr(w.order, file)
	}
	delete(w.inflight, file)
	w.gen[file]++
}

func (w *FileWriter) Has(file string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.pending[file]
	return ok
}

func (w *FileWriter) HasPendingUnder(dir string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	for f := range w.pending {
		if strings.HasPrefix(f, dir) {
			return true
		}
	}
	for f := range w.inflight {
		if strings.HasPrefix(f, dir) {
			return true
		}
	}
	return false
}

func removeStr(xs []string, s string) []string {
	out := xs[:0]
	for _, x := range xs {
		if x != s {
			out = append(out, x)
		}
	}
	return out
}

type fwJob struct {
	file string
	p    Produce
}

func (w *FileWriter) take() []fwJob {
	if w.timer != nil {
		jsrt.ClearTimeout(w.timer)
		w.timer = nil
	}
	batch := make([]fwJob, 0, len(w.order))
	for _, f := range w.order {
		batch = append(batch, fwJob{f, w.pending[f]})
	}
	w.pending = map[string]Produce{}
	w.order = nil
	return batch
}

func (w *FileWriter) tmpName(file string) string {
	w.seq++
	return fmt.Sprintf("%s.%d.%d.tmp", file, os.Getpid(), w.seq)
}

// Flush writes everything pending asynchronously; the returned channel closes when written.
func (w *FileWriter) Flush() <-chan struct{} {
	w.mu.Lock()
	batch := w.take()
	if len(batch) == 0 {
		c := w.chain
		w.mu.Unlock()
		return c
	}
	w.mu.Unlock()
	type job struct {
		file, data, tmp string
		g               int
	}
	var jobs []job
	for _, b := range batch {
		data, err := b.p()
		if err != nil {
			w.onError(b.file, err)
			continue
		}
		w.mu.Lock()
		w.gen[b.file]++
		g := w.gen[b.file]
		w.inflight[b.file] = inflightWrite{data, g}
		jobs = append(jobs, job{b.file, data, w.tmpName(b.file), g})
		w.mu.Unlock()
	}
	w.mu.Lock()
	prev := w.chain
	next := make(chan struct{})
	w.chain = next
	w.mu.Unlock()
	go func() {
		<-prev
		var wg sync.WaitGroup
		for _, j := range jobs {
			wg.Add(1)
			go func(j job) {
				defer wg.Done()
				done := func() {
					w.mu.Lock()
					if cur, ok := w.inflight[j.file]; ok && cur.g == j.g {
						delete(w.inflight, j.file)
					}
					w.mu.Unlock()
				}
				defer done()
				if err := os.WriteFile(j.tmp, []byte(j.data), 0o666); err != nil {
					_ = os.Remove(j.tmp)
					jsrt.Go(func() { w.onError(j.file, err) })
					return
				}
				w.mu.Lock()
				stale := w.gen[j.file] != j.g
				var err error
				if !stale {
					err = os.Rename(j.tmp, j.file)
				}
				w.mu.Unlock()
				if stale || err != nil {
					_ = os.Remove(j.tmp)
				}
				if err != nil {
					jsrt.Go(func() { w.onError(j.file, err) })
				}
			}(j)
		}
		wg.Wait()
		close(next)
	}()
	return next
}

// FlushSync writes everything pending now, synchronously.
func (w *FileWriter) FlushSync() {
	w.mu.Lock()
	batch := w.take()
	seen := map[string]bool{}
	for _, b := range batch {
		seen[b.file] = true
	}
	for f, in := range w.inflight {
		if !seen[f] {
			data := in.data
			batch = append(batch, fwJob{f, func() (string, error) { return data, nil }})
		}
	}
	w.inflight = map[string]inflightWrite{}
	w.mu.Unlock()
	for _, b := range batch {
		w.mu.Lock()
		w.gen[b.file]++
		tmp := w.tmpName(b.file)
		w.mu.Unlock()
		data, err := b.p()
		if err == nil {
			err = os.WriteFile(tmp, []byte(data), 0o666)
		}
		if err == nil {
			err = os.Rename(tmp, b.file)
		}
		if err != nil {
			_ = os.Remove(tmp)
			w.onError(b.file, err)
		}
	}
}

// Dispose = flushSync + stop tracking.
func (w *FileWriter) Dispose() {
	w.FlushSync()
	liveMu.Lock()
	delete(liveWriters, w)
	liveMu.Unlock()
}

// FlushPendingWritesSync = flushPendingWritesSync(dir?)（dir "" = 全部）。
func FlushPendingWritesSync(dir string) {
	liveMu.Lock()
	ws := make([]*FileWriter, 0, len(liveWriters))
	for w := range liveWriters {
		ws = append(ws, w)
	}
	liveMu.Unlock()
	for _, w := range ws {
		if dir == "" || w.HasPendingUnder(dir) {
			w.FlushSync()
		}
	}
}
