package knowledge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
)

type ChunkRec struct {
	ID     string `json:"id"`
	Text   string `json:"text"`
	Page   int    `json:"page,omitempty"`
	Offset int    `json:"offset"`
	// Vec：base64 Float32 向量
	Vec     string    `json:"vec,omitempty"`
	decoded []float32 `json:"-"`
}

type DocRec struct {
	ID         string      `json:"id"`
	SourceID   string      `json:"sourceId"`
	Path       string      `json:"path"`
	Title      string      `json:"title"`
	Ext        string      `json:"ext"`
	Mtime      float64     `json:"mtime"`
	Size       int64       `json:"size"`
	IndexedAt  int64       `json:"indexedAt"`
	Status     string      `json:"status"`
	Error      string      `json:"error,omitempty"`
	Ocr        bool        `json:"ocr,omitempty"`
	EmbedModel string      `json:"embedModel,omitempty"`
	Chunks     []*ChunkRec `json:"chunks"`
}

type Hit struct {
	ChunkID string  `json:"chunkId"`
	DocID   string  `json:"docId"`
	Path    string  `json:"path"`
	Title   string  `json:"title"`
	Page    int     `json:"page,omitempty"`
	Text    string  `json:"text"`
	Score   float64 `json:"score"`
}

type IndexStats struct {
	Docs    int `json:"docs"`
	Chunks  int `json:"chunks"`
	Vectors int `json:"vectors"`
	Errors  int `json:"errors"`
}

// KnowledgeIndex：文档 → 分块 → BM25（启动时由分块重建）+ 可选向量；JSON 持久化
type KnowledgeIndex struct {
	mu       sync.RWMutex
	file     string
	docs     *omap[*DocRec]
	chunkDoc map[string]string
	chunkBy  map[string]*ChunkRec
	bm25     *Bm25Index
	dirty    bool
}

func NewIndex(file string) *KnowledgeIndex {
	x := &KnowledgeIndex{file: file, docs: newOmap[*DocRec](), chunkDoc: map[string]string{}, chunkBy: map[string]*ChunkRec{}, bm25: NewBm25()}
	if file != "" {
		x.load()
	}
	return x
}

func (x *KnowledgeIndex) load() {
	b, err := os.ReadFile(x.file)
	if err != nil {
		return
	}
	var j struct {
		V    any               `json:"v"`
		Docs []json.RawMessage `json:"docs"`
	}
	if json.Unmarshal(b, &j) != nil || j.V != float64(1) || j.Docs == nil {
		return
	}
	for _, raw := range j.Docs {
		var probe map[string]any
		if json.Unmarshal(raw, &probe) != nil || probe == nil {
			continue
		}
		if _, ok := probe["id"].(string); !ok {
			continue
		}
		if _, ok := probe["chunks"].([]any); !ok {
			continue
		}
		var d DocRec
		if json.Unmarshal(raw, &d) == nil {
			x.putLocked(&d)
		}
	}
	x.dirty = false
}

func (x *KnowledgeIndex) Save() error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.file == "" || !x.dirty {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(x.file), 0o755); err != nil {
		return err
	}
	docs := x.docsForDisk()
	// 键序 {"v":1,"docs":…}
	b := append(append([]byte(`{"v":1,"docs":`), mustArr(docs)...), '}')
	tmp := x.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, x.file); err != nil {
		return err
	}
	x.dirty = false
	return nil
}

func mustArr(v any) []byte {
	b, err := deps.Stringify(v, "")
	if err != nil {
		return []byte("[]")
	}
	return b
}

func (x *KnowledgeIndex) docsForDisk() []DocRec {
	out := []DocRec{}
	x.docs.Each(func(_ string, d *DocRec) bool {
		cp := *d
		cp.Chunks = make([]*ChunkRec, len(d.Chunks))
		for i, c := range d.Chunks {
			cc := *c
			if cc.Vec == "" && c.decoded != nil {
				cc.Vec = VecToB64(c.decoded)
			}
			cp.Chunks[i] = &cc
		}
		out = append(out, cp)
		return true
	})
	return out
}

func (x *KnowledgeIndex) Get(id string) (*DocRec, bool) {
	x.mu.RLock()
	defer x.mu.RUnlock()
	return x.docs.Get(id)
}

func (x *KnowledgeIndex) List() []*DocRec {
	x.mu.RLock()
	defer x.mu.RUnlock()
	return x.docs.Values()
}

func (x *KnowledgeIndex) BySource(sourceID string) []*DocRec {
	out := []*DocRec{}
	for _, d := range x.List() {
		if d.SourceID == sourceID {
			out = append(out, d)
		}
	}
	return out
}

func (x *KnowledgeIndex) Put(d *DocRec) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.putLocked(d)
}

func (x *KnowledgeIndex) putLocked(d *DocRec) {
	x.removeLocked(d.ID)
	if d.Chunks == nil {
		d.Chunks = []*ChunkRec{}
	}
	x.docs.Set(d.ID, d)
	for _, c := range d.Chunks {
		x.chunkDoc[c.ID] = d.ID
		x.chunkBy[c.ID] = c
		x.bm25.Add(c.ID, d.Title+"\n"+c.Text)
	}
	x.dirty = true
}

func (x *KnowledgeIndex) Remove(id string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.removeLocked(id)
}

func (x *KnowledgeIndex) removeLocked(id string) {
	d, ok := x.docs.Get(id)
	if !ok {
		return
	}
	for _, c := range d.Chunks {
		delete(x.chunkDoc, c.ID)
		delete(x.chunkBy, c.ID)
		x.bm25.Remove(c.ID)
	}
	x.docs.Delete(id)
	x.dirty = true
}

func (x *KnowledgeIndex) RemoveSource(sourceID string) int {
	ids := x.BySource(sourceID)
	for _, d := range ids {
		x.Remove(d.ID)
	}
	return len(ids)
}

func (x *KnowledgeIndex) Clear() {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.docs = newOmap[*DocRec]()
	x.chunkDoc = map[string]string{}
	x.chunkBy = map[string]*ChunkRec{}
	x.bm25 = NewBm25()
	x.dirty = true
}

func (x *KnowledgeIndex) Stats() IndexStats {
	x.mu.RLock()
	defer x.mu.RUnlock()
	var s IndexStats
	s.Docs = x.docs.Len()
	x.docs.Each(func(_ string, d *DocRec) bool {
		s.Chunks += len(d.Chunks)
		for _, c := range d.Chunks {
			if c.Vec != "" || c.decoded != nil {
				s.Vectors++
			}
		}
		if d.Status == "error" {
			s.Errors++
		}
		return true
	})
	return s
}

func (x *KnowledgeIndex) vec(c *ChunkRec) []float32 {
	if c.decoded != nil {
		return c.decoded
	}
	if c.Vec == "" {
		return nil
	}
	c.decoded = B64ToVec(c.Vec)
	c.Vec = ""
	return c.decoded
}

type SearchOpts struct {
	Limit      int
	QueryVec   []float32
	EmbedModel string
	SourceIDs  []string
	HasSources bool
	MaxPerDoc  int
}

func (x *KnowledgeIndex) Search(query string, o SearchOpts) []Hit {
	x.mu.Lock()
	defer x.mu.Unlock()
	limit := o.Limit
	if limit == 0 {
		limit = 8
	}
	maxPer := o.MaxPerDoc
	if maxPer == 0 {
		maxPer = 2
	}
	var allow map[string]bool
	if o.HasSources || o.SourceIDs != nil {
		allow = map[string]bool{}
		for _, s := range o.SourceIDs {
			allow[s] = true
		}
	}
	ok := func(chunkID string) bool {
		if allow == nil {
			return true
		}
		d, has := x.docs.Get(x.chunkDoc[chunkID])
		return has && allow[d.SourceID]
	}
	lists := [][]Scored{x.bm25.Search(query, 60, ok)}
	if o.QueryVec != nil {
		scored := []Scored{}
		x.docs.Each(func(_ string, d *DocRec) bool {
			if allow != nil && !allow[d.SourceID] {
				return true
			}
			if o.EmbedModel != "" && d.EmbedModel != o.EmbedModel {
				return true
			}
			for _, c := range d.Chunks {
				if v := x.vec(c); v != nil {
					scored = append(scored, Scored{c.ID, Cosine(o.QueryVec, v)})
				}
			}
			return true
		})
		sort.SliceStable(scored, func(i, j int) bool { return scored[i].Score > scored[j].Score })
		if len(scored) > 60 {
			scored = scored[:60]
		}
		f := []Scored{}
		for _, s := range scored {
			if s.Score > 0.2 {
				f = append(f, s)
			}
		}
		lists = append(lists, f)
	}
	fused := lists[0]
	if len(lists) > 1 {
		fused = RRF(lists, 60)
	}
	perDoc := map[string]int{}
	out := []Hit{}
	for _, f := range fused {
		d, has := x.docs.Get(x.chunkDoc[f.ID])
		c := x.chunkBy[f.ID]
		if !has || c == nil {
			continue
		}
		if perDoc[d.ID] >= maxPer {
			continue
		}
		perDoc[d.ID]++
		out = append(out, Hit{ChunkID: c.ID, DocID: d.ID, Path: d.Path, Title: d.Title, Page: c.Page, Text: c.Text, Score: f.Score})
		if len(out) >= limit {
			break
		}
	}
	return out
}
