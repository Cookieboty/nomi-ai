package agents

// fsscan.go 移植 agents/fsScan.ts（ScanCache）。Node 用 fs.promises + 并发池；这里在
// GIL 外顺序执行（Service 把整轮扫描放到后台 goroutine），结果按深度优先目录项顺序拼接、
// 再按 mtime 稳定倒序——与 Node 的 Promise.all(...).flat() + sort 一致。

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
)

const (
	maxVisited = 20_000
	dirRacyMs  = 2_000
)

type dirEnt struct {
	name      string
	dir, file bool
}

// ScanOpts mirrors ScanOpts。
type ScanOpts struct {
	Now, HotMs float64
	Full       bool
}

type dirHit struct {
	mtime   float64
	ents    []dirEnt
	trusted bool
	gen     int
}

type fileHit struct {
	mtime float64
	gen   int
}

type parsedHit struct {
	mtime float64
	size  int64
	val   any
	gen   int
}

// ScanCache mirrors ScanCache（单一调用方串行使用；不需要锁）。
type ScanCache struct {
	dirs   map[string]*dirHit
	files  map[string]*fileHit
	parsed map[string]*parsedHit
	gen    int
	// wallNow = Date.now()（DIR_RACY 判定用真实时钟，与 Node 一致）；测试可替换。
	wallNow func() float64
}

func NewScanCache() *ScanCache {
	return &ScanCache{dirs: map[string]*dirHit{}, files: map[string]*fileHit{}, parsed: map[string]*parsedHit{},
		wallNow: func() float64 { return float64(time.Now().UnixMilli()) }}
}

func (c *ScanCache) Begin() { c.gen++ }

func (c *ScanCache) End() {
	for k, v := range c.dirs {
		if v.gen != c.gen {
			delete(c.dirs, k)
		}
	}
	for k, v := range c.files {
		if v.gen != c.gen {
			delete(c.files, k)
		}
	}
	for k, v := range c.parsed {
		if v.gen < c.gen-1 {
			delete(c.parsed, k)
		}
	}
}

func (c *ScanCache) stat(p string) os.FileInfo {
	st, err := os.Stat(p)
	if err != nil {
		return nil
	}
	return st
}

func (c *ScanCache) listDir(d string) ([]dirEnt, bool, bool) {
	st := c.stat(d)
	if st == nil || !st.IsDir() {
		return nil, false, false
	}
	mt := sh.MtimeMs(st)
	if hit := c.dirs[d]; hit != nil && hit.trusted && hit.mtime == mt {
		hit.gen = c.gen
		return hit.ents, false, true
	}
	f, err := os.Open(d)
	if err != nil {
		return nil, false, false
	}
	raw, err := f.ReadDir(-1) // 目录顺序（不排序），= fs.readdir
	f.Close()
	if err != nil {
		return nil, false, false
	}
	ents := make([]dirEnt, len(raw))
	for i, e := range raw {
		ents[i] = dirEnt{e.Name(), sh.IsDirentDir(e), sh.IsDirentFile(e)}
	}
	c.dirs[d] = &dirHit{mtime: mt, ents: ents, trusted: c.wallNow()-mt > dirRacyMs, gen: c.gen}
	return ents, true, true
}

func (c *ScanCache) fileMtime(p string, fresh bool, o ScanOpts) (float64, bool) {
	if hit := c.files[p]; hit != nil && !fresh && !o.Full && o.Now-hit.mtime >= o.HotMs {
		hit.gen = c.gen
		return hit.mtime, true
	}
	st := c.stat(p)
	if st == nil {
		delete(c.files, p)
		return 0, false
	}
	mt := sh.MtimeMs(st)
	c.files[p] = &fileHit{mtime: mt, gen: c.gen}
	return mt, true
}

// FileRef = { path, mtime }。
type FileRef struct {
	Path  string
	Mtime float64
}

// ListFiles mirrors listFiles。
func (c *ScanCache) ListFiles(dir string, pred func(n, full string) bool, depth, limit int, o ScanOpts) []FileRef {
	visited := 0
	var walk func(d string, dep int) []FileRef
	walk = func(d string, dep int) []FileRef {
		ents, fresh, ok := c.listDir(d)
		if !ok {
			return nil
		}
		type part struct {
			sub  string
			file *FileRef
		}
		parts := []part{}
		for _, e := range ents {
			visited++
			p := filepath.Join(d, e.name)
			if e.dir {
				// Node 在父目录循环里同步调用 walk(p)：dep / visited 判定发生在此刻。
				if dep-1 < 0 || visited > maxVisited {
					continue
				}
				parts = append(parts, part{sub: p})
			} else if e.file && pred(e.name, p) {
				if m, ok := c.fileMtime(p, fresh, o); ok {
					parts = append(parts, part{file: &FileRef{p, m}})
				}
			}
		}
		out := []FileRef{}
		for _, pt := range parts {
			if pt.file != nil {
				out = append(out, *pt.file)
			} else {
				out = append(out, walk(pt.sub, dep-1)...)
			}
		}
		return out
	}
	var out []FileRef
	if depth >= 0 {
		out = walk(dir, depth)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Mtime > out[j].Mtime })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// ReadParsed mirrors readParsed（同一路径必须始终用同一个 parse）。
func ReadParsed[T any](c *ScanCache, p string, bytes int64, parse func(string) T) T {
	st := c.stat(p)
	if st == nil {
		delete(c.parsed, p)
		return parse("")
	}
	if hit := c.parsed[p]; hit != nil && hit.mtime == sh.MtimeMs(st) && hit.size == st.Size() {
		hit.gen = c.gen
		return hit.val.(T)
	}
	val := parse(ReadSlice(p, false, bytes))
	c.parsed[p] = &parsedHit{mtime: sh.MtimeMs(st), size: st.Size(), val: val, gen: c.gen}
	return val
}

// ReadSlice mirrors readSliceAsync（tail=false 读开头）。
func ReadSlice(p string, tail bool, bytes int64) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	size := st.Size()
	n := bytes
	if size < n {
		n = size
	}
	if n < 0 {
		return ""
	}
	buf := make([]byte, n)
	off := int64(0)
	if tail {
		off = size - n
	}
	if _, err := f.ReadAt(buf, off); err != nil && err != io.EOF {
		return "" // EISDIR 等：Node 的 catch → ''
	}
	return charcontract.DecodeUTF8(buf)
}
