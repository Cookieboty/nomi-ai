package usage

// 对应 apps/desktop-electron/internal/core/src/usage/sniff.ts：从本地路由经过的上游响应里取 usage（非流式 JSON / 流式 SSE）

import (
	"math"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// SniffedUsage：字段顺序 = mergeUsage 里 merged 的字面量顺序
type SniffedUsage struct {
	Input        float64  `json:"input"`
	Output       float64  `json:"output"`
	CacheRead    float64  `json:"cacheRead"`
	CacheWrite   float64  `json:"cacheWrite"`
	Model        *string  `json:"model,omitempty"`
	ID           *string  `json:"id,omitempty"`
	CacheWrite1h *float64 `json:"cacheWrite1h,omitempty"`
	Fast         *bool    `json:"fast,omitempty"`
}

// PartialSniffed：usageFromObject 的片段（四个 token 字段总在；其余缺省 = undefined）
type PartialSniffed = SniffedUsage

func snNum(v any) float64 {
	if f, ok := v.(float64); ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f > 0 {
		return f
	}
	return 0
}

func snObj(v any) *util.Obj {
	o, _ := v.(*util.Obj)
	return o
}

func snGet(o *util.Obj, k string) any {
	if o == nil {
		return nil
	}
	return o.Get(k)
}

func snStr(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && s != ""
}

// UsageFromObject：整包响应或一个 SSE 事件里的 usage 片段；没有返回 nil
func UsageFromObject(raw any) *PartialSniffed {
	o := snObj(raw)
	if o == nil {
		return nil
	}
	gm := snObj(o.Get("usageMetadata"))
	if gm == nil {
		gm = snObj(snGet(snObj(o.Get("response")), "usageMetadata"))
	}
	if gm != nil {
		cached := snNum(gm.Get("cachedContentTokenCount"))
		r := &PartialSniffed{
			Input:     math.Max(0, snNum(gm.Get("promptTokenCount"))-cached),
			Output:    snNum(gm.Get("candidatesTokenCount")) + snNum(gm.Get("thoughtsTokenCount")),
			CacheRead: cached,
		}
		if s, ok := o.Get("modelVersion").(string); ok {
			r.Model = &s
		}
		return r
	}
	msg := snObj(o.Get("message"))
	resp := snObj(o.Get("response"))
	u := snObj(o.Get("usage"))
	if u == nil {
		u = snObj(snGet(msg, "usage"))
	}
	if u == nil {
		u = snObj(snGet(resp, "usage"))
	}
	if u == nil {
		return nil
	}
	var model, id *string
	for _, v := range []any{o.Get("model"), snGet(msg, "model"), snGet(resp, "model")} {
		if s, ok := snStr(v); ok {
			model = &s
			break
		}
	}
	for _, v := range []any{snGet(msg, "id"), snGet(resp, "id"), o.Get("id")} {
		if s, ok := snStr(v); ok {
			id = &s
			break
		}
	}
	fast := func(r *PartialSniffed) {
		if s, ok := u.Get("speed").(string); ok && s == "fast" {
			r.Fast = boolp(true)
		}
	}
	if u.Has("input_tokens") && (u.Has("cache_read_input_tokens") || u.Has("cache_creation_input_tokens") || !u.Has("input_tokens_details")) {
		cc := snObj(u.Get("cache_creation"))
		w1hRaw := snNum(snGet(cc, "ephemeral_1h_input_tokens"))
		cw := snNum(u.Get("cache_creation_input_tokens"))
		if cw == 0 {
			cw = snNum(snGet(cc, "ephemeral_5m_input_tokens")) + w1hRaw
		}
		r := &PartialSniffed{Input: snNum(u.Get("input_tokens")), Output: snNum(u.Get("output_tokens")),
			CacheRead: snNum(u.Get("cache_read_input_tokens")), CacheWrite: cw, Model: model, ID: id}
		if w := math.Min(w1hRaw, cw); w != 0 && !math.IsNaN(w) {
			r.CacheWrite1h = f64p(w)
		}
		fast(r)
		return r
	}
	if u.Has("input_tokens") {
		cached := snNum(snGet(snObj(u.Get("input_tokens_details")), "cached_tokens"))
		return &PartialSniffed{Input: math.Max(0, snNum(u.Get("input_tokens"))-cached), Output: snNum(u.Get("output_tokens")),
			CacheRead: cached, Model: model, ID: id}
	}
	if u.Has("output_tokens") {
		r := &PartialSniffed{Output: snNum(u.Get("output_tokens")), Model: model, ID: id}
		fast(r)
		return r
	}
	if u.Has("prompt_tokens") || u.Has("completion_tokens") {
		cached := snNum(snGet(snObj(u.Get("prompt_tokens_details")), "cached_tokens"))
		return &PartialSniffed{Input: math.Max(0, snNum(u.Get("prompt_tokens"))-cached), Output: snNum(u.Get("completion_tokens")),
			CacheRead: cached, Model: model, ID: id}
	}
	return nil
}

func snOr0(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func snTruthyS(p *string) bool { return p != nil && *p != "" }

// MergeUsage：同一次响应里先后出现的片段取各字段最大值
func MergeUsage(a SniffedUsage, b *PartialSniffed) SniffedUsage {
	cw := math.Max(a.CacheWrite, b.CacheWrite)
	w1h := math.Min(math.Max(snOr0(a.CacheWrite1h), snOr0(b.CacheWrite1h)), cw)
	m := SniffedUsage{Input: math.Max(a.Input, b.Input), Output: math.Max(a.Output, b.Output),
		CacheRead: math.Max(a.CacheRead, b.CacheRead), CacheWrite: cw}
	switch {
	case snTruthyS(b.Model):
		m.Model = b.Model
	default:
		m.Model = a.Model // b.model || a.model
	}
	if snTruthyS(a.ID) {
		m.ID = a.ID
	} else if snTruthyS(b.ID) {
		m.ID = b.ID
	}
	if w1h != 0 && !math.IsNaN(w1h) {
		m.CacheWrite1h = f64p(w1h)
	}
	if (a.Fast != nil && *a.Fast) || (b.Fast != nil && *b.Fast) {
		m.Fast = boolp(true)
	}
	return m
}

func EmptySniffed() SniffedUsage { return SniffedUsage{} }

func HasTokens(u SniffedUsage) bool {
	return u.Input > 0 || u.Output > 0 || u.CacheRead > 0 || u.CacheWrite > 0
}

// SseUsageTap：增量 SSE 嗅探（不保存正文）
type SseUsageTap struct {
	buf   string
	Usage SniffedUsage
}

func NewSseUsageTap() *SseUsageTap { return &SseUsageTap{} }

func (t *SseUsageTap) Push(text string) {
	t.buf += text
	for {
		i := strings.IndexByte(t.buf, '\n')
		if i < 0 {
			break
		}
		line := util.JSTrim(t.buf[:i])
		t.buf = t.buf[i+1:]
		t.line(line)
	}
	if len(t.buf) > 4*1024*1024 && util.UTF16Len(t.buf) > 4*1024*1024 {
		t.buf = ""
	}
}

func (t *SseUsageTap) End() SniffedUsage {
	t.line(util.JSTrim(t.buf))
	t.buf = ""
	return t.Usage
}

func (t *SseUsageTap) line(line string) {
	if !strings.HasPrefix(line, "data:") {
		return
	}
	data := util.JSTrim(line[5:])
	if data == "" || data == "[DONE]" {
		return
	}
	v, err := util.ParseString(data)
	if err != nil {
		return
	}
	if part := UsageFromObject(v); part != nil {
		t.Usage = MergeUsage(t.Usage, part)
	}
}
