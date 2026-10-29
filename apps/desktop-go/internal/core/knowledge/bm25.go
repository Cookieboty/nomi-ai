package knowledge

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
)

type termMap = *omap[int]

// Bm25Index：增量 BM25 倒排索引，可序列化为 JSON（{v:1, docs:[[id,len,{term:count}]]}）
type Bm25Index struct {
	tf       *omap[termMap]
	length   map[string]int
	df       map[string]int
	totalLen int
	k1, b    float64
}

func NewBm25() *Bm25Index {
	return &Bm25Index{tf: newOmap[termMap](), length: map[string]int{}, df: map[string]int{}, k1: 1.2, b: 0.75}
}

func (x *Bm25Index) Size() int { return len(x.length) }

func (x *Bm25Index) Add(id, text string) {
	m := newOmap[int]()
	terms := Tokenize(text)
	for _, t := range terms {
		c, _ := m.Get(t)
		m.Set(t, c+1)
	}
	x.addTerms(id, m, len(terms))
}

func (x *Bm25Index) addTerms(id string, m termMap, n int) {
	if _, ok := x.length[id]; ok {
		x.Remove(id)
	}
	x.tf.Set(id, m)
	x.length[id] = n
	x.totalLen += n
	m.Each(func(t string, _ int) bool { x.df[t]++; return true })
}

func (x *Bm25Index) Remove(id string) {
	m, ok := x.tf.Get(id)
	if !ok {
		return
	}
	m.Each(func(t string, _ int) bool {
		d, ok := x.df[t]
		if !ok {
			d = 1
		}
		d--
		if d <= 0 {
			delete(x.df, t)
		} else {
			x.df[t] = d
		}
		return true
	})
	x.totalLen -= x.length[id]
	x.tf.Delete(id)
	delete(x.length, id)
}

type Scored struct {
	ID    string  `json:"id"`
	Score float64 `json:"score"`
}

func (x *Bm25Index) Search(query string, limit int, filter func(string) bool) []Scored {
	seen := map[string]bool{}
	var q []string
	for _, t := range Tokenize(query) {
		if !seen[t] {
			seen[t] = true
			q = append(q, t)
		}
	}
	if len(q) == 0 || len(x.length) == 0 {
		return []Scored{}
	}
	N := float64(len(x.length))
	avg := float64(x.totalLen) / N
	if avg == 0 || math.IsNaN(avg) {
		avg = 1
	}
	scores := newOmap[float64]()
	for _, term := range q {
		dfi := x.df[term]
		if dfi == 0 {
			continue
		}
		df := float64(dfi)
		idf := math.Log(1 + (N-df+0.5)/(df+0.5))
		x.tf.Each(func(id string, m termMap) bool {
			fi, _ := m.Get(term)
			if fi == 0 {
				return true
			}
			if filter != nil && !filter(id) {
				return true
			}
			f := float64(fi)
			dl := float64(x.length[id])
			s := (idf * f * (x.k1 + 1)) / (f + x.k1*(1-x.b+(x.b*dl)/avg))
			cur, _ := scores.Get(id)
			scores.Set(id, cur+s)
			return true
		})
	}
	out := make([]Scored, 0, scores.Len())
	scores.Each(func(id string, s float64) bool { out = append(out, Scored{id, s}); return true })
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// isArrayIndex：JS 对象中按数值升序排在前面的「整数键」
func isArrayIndex(k string) bool {
	if k == "" || (len(k) > 1 && k[0] == '0') {
		return false
	}
	for _, c := range k {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return err == nil && n < 4294967295
}

// jsObjectKeys：Object.fromEntries / Object.entries 的键序
func jsObjectKeys(keys []string) []string {
	var ints, rest []string
	for _, k := range keys {
		if isArrayIndex(k) {
			ints = append(ints, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(ints, func(i, j int) bool {
		a, _ := strconv.ParseUint(ints[i], 10, 64)
		b, _ := strconv.ParseUint(ints[j], 10, 64)
		return a < b
	})
	return append(ints, rest...)
}

// MarshalJSON：与 Node toJSON() 字节一致
func (x *Bm25Index) MarshalJSON() ([]byte, error) {
	buf := []byte(`{"v":1,"docs":[`)
	first := true
	var err error
	x.tf.Each(func(id string, m termMap) bool {
		if !first {
			buf = append(buf, ',')
		}
		first = false
		idb, _ := deps.Stringify(id, "")
		buf = append(buf, '[')
		buf = append(buf, idb...)
		buf = append(buf, ',')
		buf = strconv.AppendInt(buf, int64(x.length[id]), 10)
		buf = append(buf, ",{"...)
		for i, k := range jsObjectKeys(m.Keys()) {
			if i > 0 {
				buf = append(buf, ',')
			}
			kb, _ := deps.Stringify(k, "")
			c, _ := m.Get(k)
			buf = append(buf, kb...)
			buf = append(buf, ':')
			buf = strconv.AppendInt(buf, int64(c), 10)
		}
		buf = append(buf, "}]"...)
		return true
	})
	buf = append(buf, "]}"...)
	return buf, err
}

// Bm25FromJSON：容错解析；不合法的条目跳过
func Bm25FromJSON(raw []byte) *Bm25Index {
	idx := NewBm25()
	var o struct {
		V    any               `json:"v"`
		Docs []json.RawMessage `json:"docs"`
	}
	if json.Unmarshal(raw, &o) != nil || o.V != float64(1) || o.Docs == nil {
		return idx
	}
	for _, d := range o.Docs {
		var arr []json.RawMessage
		if json.Unmarshal(d, &arr) != nil || len(arr) < 3 {
			continue
		}
		var id string
		if json.Unmarshal(arr[0], &id) != nil || arr[0][0] != '"' {
			continue
		}
		keys, vals, ok := orderedObject(arr[2])
		if !ok {
			continue
		}
		m := newOmap[int]()
		n := 0
		for i, k := range jsObjectKeys(keys) {
			_ = i
			if v, ok := vals[k].(float64); ok {
				m.Set(k, int(v))
				n += int(v)
			}
		}
		idx.addTerms(id, m, n)
	}
	return idx
}

// orderedObject：按出现顺序解析 JSON 对象的键（JSON 重复键取后者，键序取首次出现，同 JS）
func orderedObject(raw json.RawMessage) ([]string, map[string]any, bool) {
	dec := json.NewDecoder(bytesReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, nil, false
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, nil, false
	}
	var keys []string
	vals := map[string]any{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, nil, false
		}
		k := kt.(string)
		var v any
		if dec.Decode(&v) != nil {
			return nil, nil, false
		}
		if _, ok := vals[k]; !ok {
			keys = append(keys, k)
		}
		vals[k] = v
	}
	return keys, vals, true
}
