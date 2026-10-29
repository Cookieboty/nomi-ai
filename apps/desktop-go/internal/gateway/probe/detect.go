// Package probe = packages/gateway/src/probe/detect.ts（unified-gateway §8 协议探测）：
// 地址规范化 → 拉模型列表（顺带判断鉴权方式）→ 各协议并行发最小请求 → 按 Key 记录结果。
package probe

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/ir"
	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var (
	endpointSuffix = regexp.MustCompile(`(?i)/(?:v1/)?(?:chat/completions|responses|messages(?:/count_tokens)?|completions|models/[^/]+:(?:stream)?generateContent(?:\?.*)?|models)$`)
	trailing       = regexp.MustCompile(`/+$`)
	httpScheme     = regexp.MustCompile(`(?i)^https?://`)
	v1Suffix       = regexp.MustCompile(`/v1$`)
	nonChat        = regexp.MustCompile(`(?i)image|embed|tts|whisper|dall-e|audio|speech|video|seedance|rerank|moderation`)
	reClaude       = regexp.MustCompile(`(?i)^claude`)
	reResponses    = regexp.MustCompile(`(?i)^(gpt-|codex|o[0-9])`)
	reGemini       = regexp.MustCompile(`(?i)^gemini`)
	reModelsPrefix = regexp.MustCompile(`^models/`)
)

// NormalizeBases = normalizeBases：用户贴的任意形式 → 每种协议的候选 base（键序 chat, responses, messages, gemini）
func NormalizeBases(raw string) *u.Obj {
	s := trailing.ReplaceAllString(u.JSTrim(raw), "")
	if s == "" {
		return u.NewObj()
	}
	if !httpScheme.MatchString(s) {
		s = "https://" + s
	}
	s = trailing.ReplaceAllString(endpointSuffix.ReplaceAllString(s, ""), "")
	pu, err := gwnet.ParseURL(s)
	if err != nil {
		return u.NewObj()
	}
	origin := strings.ToLower(pu.Scheme) + "://" + pu.Host
	path := pu.EscapedPath()
	if path == "" {
		path = "/"
	}
	path = trailing.ReplaceAllString(path, "")
	openai := origin + "/v1"
	if path != "" {
		openai = origin + path
	}
	messages := origin + v1Suffix.ReplaceAllString(path, "")
	gemini := origin + path
	if path == "" || path == "/v1" {
		gemini = origin + "/v1beta"
	}
	return u.NewObj("chat", openai, "responses", openai, "messages", messages, "gemini", gemini)
}

// Key = ProbeKey
type Key struct{ ID, Value string }

// Options = DetectOptions
type Options struct {
	Bases               *u.Obj
	Keys                []Key
	FallbackModel       string
	TimeoutMs           int
	Concurrency         int
	FetchImpl           gwnet.UpstreamFetch
	AllowedPrivateHosts []string
	SelfPort            int
	LookupAll           gwnet.LookupAll
	// Now = Date.now（测试注入）
	Now func() float64
}

const timeoutMs = 15_000

func (o *Options) now() float64 {
	if o.Now != nil {
		return o.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (o *Options) base(w string) string { s, _ := o.Bases.Get(w).(string); return s }

func (o *Options) guard() gwnet.GuardOpts {
	return gwnet.GuardOpts{AllowedPrivateHosts: o.AllowedPrivateHosts, SelfPort: o.SelfPort, LookupAll: o.LookupAll}
}

func (o *Options) fetch() gwnet.UpstreamFetch {
	if o.FetchImpl != nil {
		return o.FetchImpl
	}
	return gwnet.CreateUpstreamFetch(gwnet.FetchOptions{GetGuard: o.guard})
}

func (o *Options) timeout() time.Duration {
	t := o.TimeoutMs
	if t == 0 {
		t = timeoutMs
	}
	return time.Duration(t) * time.Millisecond
}

func lastSeg(m string) string { p := strings.Split(m, "/"); return p[len(p)-1] }

func pickModel(wire string, all []string, fallback string) string {
	var models []string
	for _, m := range all {
		if !nonChat.MatchString(m) {
			models = append(models, m)
		}
	}
	by := func(re *regexp.Regexp) string {
		for _, m := range models {
			if re.MatchString(lastSeg(m)) {
				return m
			}
		}
		return ""
	}
	or := func(xs ...string) string {
		for _, x := range xs {
			if x != "" {
				return x
			}
		}
		return ""
	}
	first := ""
	if len(models) > 0 {
		first = models[0]
	}
	switch wire {
	case "messages":
		return or(by(reClaude), first, fallback)
	case "responses":
		return or(by(reResponses), first, fallback)
	case "gemini":
		return or(by(reGemini), first, fallback)
	}
	return or(first, fallback)
}

func probeBody(wire, model string) string {
	msgs := []any{u.NewObj("role", "user", "content", "hi")}
	switch wire {
	case "messages", "chat":
		return u.Stringify(u.NewObj("model", model, "max_tokens", float64(1), "messages", msgs))
	case "responses":
		return u.Stringify(u.NewObj("model", model, "max_output_tokens", float64(16), "input", "hi"))
	}
	return u.Stringify(u.NewObj("contents", []any{u.NewObj("parts", []any{u.NewObj("text", "hi")})},
		"generationConfig", u.NewObj("maxOutputTokens", float64(1))))
}

func authHeaders(wire, auth, key string) http.Header {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	if key != "" {
		switch auth {
		case "x-api-key":
			h.Set("x-api-key", key)
		case "x-goog-api-key":
			h.Set("x-goog-api-key", key)
		default:
			h.Set("Authorization", "Bearer "+key)
		}
	}
	if wire == "messages" {
		h.Set("anthropic-version", "2023-06-01")
	}
	return h
}

func looksLikeParamError(text string) bool {
	v, err := u.ParseString(text)
	if err != nil {
		return false
	}
	j, ok := v.(*u.Obj)
	if !ok {
		// JSON.parse 出非对象：j.error / j.type 为 undefined（null 会抛 TypeError → false）
		return false
	}
	return u.Truthy(j.Get("error")) || j.Get("type") == "error"
}

func guarded(url string, o *Options) string {
	if _, err := gwnet.CheckUpstream(context.Background(), url, o.guard()); err != nil {
		return err.Error()
	}
	return ""
}

func posInt(v any) (float64, bool) {
	var n float64
	switch x := v.(type) {
	case string:
		n = u.ToNumber(x)
	case float64:
		n = x
	default:
		return 0, false
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n <= 0 {
		return 0, false
	}
	return n, true
}

// ListedLimits = listedLimits：模型列表一项带的上下文 / 输出上限；没有 → nil
func ListedLimits(item any) *u.Obj {
	o, ok := item.(*u.Obj)
	if !ok || o == nil {
		return nil
	}
	top, _ := o.Get("top_provider").(*u.Obj)
	if top == nil {
		top = u.NewObj()
	}
	first := func(vs ...any) (float64, bool) {
		for _, v := range vs {
			if n, ok := posInt(v); ok {
				return n, true
			}
		}
		return 0, false
	}
	ctx, hc := first(o.Get("max_input_tokens"), o.Get("inputTokenLimit"), o.Get("input_token_limit"),
		o.Get("context_length"), o.Get("context_window"), o.Get("max_context_length"), o.Get("max_model_len"),
		top.Get("context_length"))
	mo, hm := first(o.Get("max_output_tokens"), o.Get("max_completion_tokens"), o.Get("outputTokenLimit"),
		o.Get("output_token_limit"), top.Get("max_completion_tokens"))
	if !hc && !hm {
		return nil
	}
	r := u.NewObj()
	if hc {
		r.Set("ctx", ctx)
	}
	if hm {
		r.Set("maxOutput", mo)
	}
	return r
}

type listed struct {
	models []string
	limits *u.Obj
	auth   string
}

func listModels(o *Options, key string) listed {
	base := o.base("chat")
	if !o.Bases.Has("chat") || o.Bases.Get("chat") == nil {
		base = o.base("responses")
	}
	if base == "" {
		return listed{}
	}
	url := trailing.ReplaceAllString(base, "") + "/models"
	if guarded(url, o) != "" {
		return listed{}
	}
	for _, auth := range []string{"bearer", "x-api-key"} {
		r, ok := func() (listed, bool) {
			ctx, cancel := context.WithTimeout(context.Background(), o.timeout())
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
			if err != nil {
				return listed{}, false
			}
			req.Header = authHeaders("chat", auth, key)
			res, err := o.fetch()(req)
			if err != nil {
				return listed{}, false
			}
			defer res.Body.Close()
			if res.StatusCode < 200 || res.StatusCode > 299 {
				return listed{}, false
			}
			b, err := io.ReadAll(res.Body)
			if err != nil {
				return listed{}, false
			}
			v, err := u.Parse(b)
			if err != nil {
				return listed{}, false
			}
			j, _ := v.(*u.Obj)
			if v == nil {
				return listed{}, false // null.data → TypeError
			}
			var items any
			if j != nil {
				items = j.Get("data")
				if items == nil {
					items = j.Get("models")
				}
			}
			out := listed{models: []string{}, auth: auth}
			lim := u.NewObj()
			arr, isArr := items.([]any)
			if items != nil && !isArr {
				return listed{}, false // for..of 非可迭代 → TypeError
			}
			for _, it := range arr {
				m, _ := it.(*u.Obj)
				if m == nil {
					if it == nil {
						return listed{}, false
					}
					continue
				}
				id := ""
				if s, ok := m.Get("id").(string); ok {
					id = s
				} else if s, ok := m.Get("name").(string); ok {
					id = reModelsPrefix.ReplaceAllString(s, "")
				}
				if id == "" {
					continue
				}
				out.models = append(out.models, id)
				if l := ListedLimits(m); l != nil {
					lim.Set(id, l)
				}
			}
			if lim.Len() > 0 {
				out.limits = lim
			}
			return out, true
		}()
		if ok {
			return r
		}
	}
	return listed{}
}

func line(kv ...any) *u.Obj { return u.NewObj(kv...) }

func probeWire(wire, base string, key Key, model, auth string, o *Options) *u.Obj {
	t0 := o.now()
	if model == "" {
		return line("wire", wire, "url", base, "ok", false, "error", "没有可用来测试的模型名，请手动填写一个", "ms", float64(0))
	}
	url := upstream.URL(wire, base, model, upstream.URLOpts{})
	if b := guarded(url, o); b != "" {
		return line("wire", wire, "url", base, "ok", false, "error", b, "ms", float64(0))
	}
	type result struct {
		status int
		text   string
	}
	attempt := func(style string) (result, error) {
		ctx, cancel := context.WithTimeout(context.Background(), o.timeout())
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBufferString(probeBody(wire, model)))
		if err != nil {
			return result{}, err
		}
		req.Header = authHeaders(wire, style, key.Value)
		res, err := o.fetch()(req)
		if err != nil {
			return result{}, err
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		if err != nil {
			b = nil
		}
		return result{res.StatusCode, string(b)}, nil
	}
	fail := func(err error) *u.Obj {
		ms := o.now() - t0
		msg := "超时"
		if !errors.Is(err, context.DeadlineExceeded) {
			msg = "连接失败：" + o.fetchErrMessage(err)
		}
		return line("wire", wire, "url", base, "ok", false, "model", model, "error", msg, "ms", ms)
	}
	r, err := attempt(auth)
	if err != nil {
		return fail(err)
	}
	used := auth
	if (r.status == 401 || r.status == 403) && (wire == "messages" || wire == "chat") {
		alt := "bearer"
		if auth == "bearer" {
			alt = "x-api-key"
		}
		r2, err := attempt(alt)
		if err != nil {
			return fail(err)
		}
		if (r2.status >= 200 && r2.status <= 299) || r2.status == 400 {
			r, used = r2, alt
		}
	}
	ms := o.now() - t0
	st := float64(r.status)
	switch {
	case r.status >= 200 && r.status <= 299:
		return line("wire", wire, "url", base, "ok", true, "status", st, "model", model, "auth", used, "ms", ms)
	case r.status == 401 || r.status == 403:
		return line("wire", wire, "url", base, "ok", false, "status", st, "model", model, "error", "Key 无效或没有权限（鉴权失败）", "ms", ms)
	case r.status == 400 && looksLikeParamError(r.text):
		return line("wire", wire, "url", base, "ok", true, "status", float64(400), "model", model, "auth", used, "ms", ms)
	}
	return line("wire", wire, "url", base, "ok", false, "status", st, "model", model, "error", "HTTP "+itoa(r.status), "ms", ms)
}

func itoa(n int) string { return u.Stringify(float64(n)) }

// fetchErrMessage：undici fetch 的网络错误统一是 TypeError('fetch failed')；
// 上游守卫拦下（UpstreamBlockedError）保留原消息；注入的 fetchImpl 抛什么就是什么（= (e as Error).message）。
func (o *Options) fetchErrMessage(err error) string {
	if o.FetchImpl != nil {
		return err.Error()
	}
	var b *gwnet.UpstreamBlockedError
	if errors.As(err, &b) {
		return b.Error()
	}
	return "fetch failed"
}

var defaultAuth = map[string]string{"messages": "x-api-key", "responses": "bearer", "chat": "bearer", "gemini": "x-goog-api-key"}

// Detect = detect(o)：返回 DetectResult（键序 wires, byKey, models, limits?, urls）
func Detect(o Options) *u.Obj {
	if o.Bases == nil {
		o.Bases = u.NewObj()
	}
	keys := o.Keys
	if len(keys) == 0 {
		keys = []Key{{ID: "none"}}
	}
	l := listModels(&o, keys[0].Value)
	byKey := u.NewObj()
	var mu sync.Mutex
	queue := append([]Key{}, keys...)
	conc := o.Concurrency
	if conc == 0 {
		conc = 4
	}
	if conc > len(queue) {
		conc = len(queue)
	}
	next := func() (Key, bool) {
		mu.Lock()
		defer mu.Unlock()
		if len(queue) == 0 {
			return Key{}, false
		}
		k := queue[0]
		queue = queue[1:]
		return k, true
	}
	var wg sync.WaitGroup
	for i := 0; i < conc; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for key, ok := next(); ok; key, ok = next() {
				var ws []string
				for _, w := range ir.Wires {
					if o.base(string(w)) != "" {
						ws = append(ws, string(w))
					}
				}
				lines := make([]*u.Obj, len(ws))
				var lw sync.WaitGroup
				for i, w := range ws {
					auth := defaultAuth[w]
					if w == "chat" && l.auth != "" {
						auth = l.auth
					}
					lw.Add(1)
					go func(i int, w, auth string) {
						defer lw.Done()
						lines[i] = probeWire(w, o.base(w), key, pickModel(w, l.models, o.FallbackModel), auth, &o)
					}(i, w, auth)
				}
				lw.Wait()
				okModel := ""
				for _, ln := range lines {
					if ln.Get("ok") == true {
						okModel, _ = ln.Get("model").(string)
						break
					}
				}
				if okModel != "" {
					for i, ln := range lines {
						st := ln.Get("status")
						specific := st == float64(401) || st == float64(403) || ln.Get("error") == "超时"
						if ln.Get("ok") == true || !specific || ln.Get("model") == okModel {
							continue
						}
						w := ln.Get("wire").(string)
						lines[i] = probeWire(w, o.base(w), key, okModel, defaultAuth[w], &o)
					}
				}
				m := u.NewObj()
				for _, ln := range lines {
					m.Set(ln.Get("wire").(string), ln)
				}
				mu.Lock()
				byKey.Set(key.ID, m)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	wires := u.NewObj()
	for _, w := range ir.Wires {
		var found []*u.Obj
		for _, k := range byKey.Keys() {
			if x, _ := byKey.Get(k).(*u.Obj).Get(string(w)).(*u.Obj); x != nil {
				found = append(found, x)
			}
		}
		if len(found) == 0 {
			continue
		}
		pick := found[0]
		for _, x := range found {
			if x.Get("ok") == true {
				pick = x
				break
			}
		}
		wires.Set(string(w), pick)
	}
	urls := u.NewObj()
	for _, w := range wires.Keys() {
		if wires.Get(w).(*u.Obj).Get("ok") == true {
			urls.Set(w, o.Bases.Get(w))
		}
	}
	models := make([]any, len(l.models))
	for i, m := range l.models {
		models[i] = m
	}
	r := u.NewObj("wires", wires, "byKey", byKey, "models", models)
	if l.limits != nil {
		r.Set("limits", l.limits)
	}
	return r.Set("urls", urls)
}
