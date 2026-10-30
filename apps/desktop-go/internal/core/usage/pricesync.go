// priceSync.ts 的移植：models.dev 数据同步（价格覆盖层）。
package usage

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const PriceSyncURL = "https://models.dev/api.json"

const (
	psMaxBodyBytes = 40 * 1024 * 1024
	psTimeout      = 45_000 * time.Millisecond
	psMinEntries   = 10
)

type psProvider struct {
	id   string
	only func(string) bool
}

// /^(qwen|qwq|qvq)/i：JS 的 i 只做 ASCII 折叠（ſ/K 等不参与），故用显式字符类
var psAlibabaRe = regexp.MustCompile(`^(?:[Qq][Ww][Ee][Nn]|[Qq][Ww][Qq]|[Qq][Vv][Qq])`)

func psAlibabaOnly(key string) bool { return psAlibabaRe.MatchString(key) }

var psFirstParty = []psProvider{
	{id: "anthropic"}, {id: "openai"}, {id: "google"}, {id: "deepseek"}, {id: "moonshotai"},
	{id: "zhipuai"}, {id: "minimax"}, {id: "xai"}, {id: "mistral"}, {id: "alibaba", only: psAlibabaOnly},
}

func psObj(v any) *util.Obj { o, _ := v.(*util.Obj); return o }

func psPrice(v any) *float64 {
	if f, ok := v.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 {
		return &f
	}
	return nil
}

type psRates struct {
	input, output         float64
	cacheRead, cacheWrite *float64
}

func psReadRates(o *util.Obj, cacheReadKey, cacheWriteKey string) *psRates {
	in, out := psPrice(o.Get("input")), psPrice(o.Get("output"))
	if in == nil || out == nil {
		return nil
	}
	r := &psRates{input: *in, output: *out}
	for i, k := range []string{cacheReadKey, cacheWriteKey} {
		if !o.Has(k) { // JSON 值里没有 undefined：缺键即 undefined，null 照常校验
			continue
		}
		v := psPrice(o.Get(k))
		if v == nil {
			return nil
		}
		if i == 0 {
			r.cacheRead = v
		} else {
			r.cacheWrite = v
		}
	}
	return r
}

func psReadTiers(raw any, present bool, cr, cw string, sizeOf func(*util.Obj) any) ([]PriceTier, bool) {
	if !present {
		return []PriceTier{}, true
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	tiers := []PriceTier{}
	seen := map[float64]bool{}
	for _, x := range arr {
		t := psObj(x)
		if t == nil {
			return nil, false
		}
		size, ok := sizeOf(t).(float64)
		if !ok || math.IsInf(size, 0) || math.IsNaN(size) || size != math.Trunc(size) || size <= 0 || seen[size] {
			return nil, false
		}
		seen[size] = true
		r := psReadRates(t, cr, cw)
		if r == nil {
			return nil, false
		}
		tiers = append(tiers, PriceTier{Size: size, Input: r.input, Output: r.output, CacheRead: r.cacheRead, CacheWrite: r.cacheWrite})
	}
	sort.SliceStable(tiers, func(i, j int) bool { return tiers[i].Size < tiers[j].Size })
	return tiers, true
}

// ReadModelsDevCost：models.dev 的 cost 对象 → 价格（nil = null）
func ReadModelsDevCost(cost any) *ModelPrice {
	c := psObj(cost)
	if c == nil {
		return nil
	}
	base := psReadRates(c, "cache_read", "cache_write")
	if base == nil {
		return nil
	}
	tiers, ok := psReadTiers(c.Get("tiers"), c.Has("tiers"), "cache_read", "cache_write", func(t *util.Obj) any {
		tier := psObj(t.Get("tier"))
		if tier != nil && (!tier.Has("type") || tier.Get("type") == "context") {
			return tier.Get("size")
		}
		return nil
	})
	if !ok {
		return nil
	}
	mp := &ModelPrice{Input: base.input, Output: base.output, CacheRead: base.cacheRead, CacheWrite: base.cacheWrite}
	if len(tiers) > 0 {
		mp.Tiers = tiers
	}
	return mp
}

type ExtractResult struct {
	Entries []PriceEntry
	Skipped int
}

func psBuiltinHas(name string) bool {
	for _, e := range BuiltinPrices {
		key := NormalizeModel(e.Model)
		if name == key || (strings.HasPrefix(name, key) && VersionSuffix.MatchString(name[len(key):])) {
			return true
		}
	}
	return false
}

type psOrdered struct {
	keys []string
	m    map[string]PriceEntry
}

func (o *psOrdered) has(k string) bool { _, ok := o.m[k]; return ok }
func (o *psOrdered) set(k string, e PriceEntry) {
	if !o.has(k) {
		o.keys = append(o.keys, k)
	}
	o.m[k] = e
}
func (o *psOrdered) values() []PriceEntry {
	r := make([]PriceEntry, 0, len(o.keys))
	for _, k := range o.keys {
		r = append(r, o.m[k])
	}
	return r
}

// ExtractPrices：models.dev 的 api.json → 覆盖层条目（纯函数）
func ExtractPrices(api any) ExtractResult {
	root := psObj(api)
	live := &psOrdered{m: map[string]PriceEntry{}}
	dep := &psOrdered{m: map[string]PriceEntry{}}
	skipped := 0
	if root == nil {
		return ExtractResult{Entries: []PriceEntry{}}
	}
	for _, prov := range psFirstParty {
		var models *util.Obj
		if p := psObj(root.Get(prov.id)); p != nil {
			models = psObj(p.Get("models"))
		}
		if models == nil {
			continue
		}
		for _, id := range models.Keys() {
			m := psObj(models.Get(id))
			src := id
			if m != nil {
				if s, ok := m.Get("id").(string); ok {
					src = s
				}
			}
			key := NormalizeModel(src)
			if m == nil || key == "" || (prov.only != nil && !prov.only(key)) {
				continue
			}
			cost := ReadModelsDevCost(m.Get("cost"))
			if cost == nil {
				skipped++
				continue
			}
			e := PriceEntry{Model: key, ModelPrice: *cost}
			if s, ok := m.Get("name").(string); ok && s != "" {
				e.Label = strp(s)
			}
			target := live
			if m.Get("status") == "deprecated" {
				target = dep
			}
			if target.has(key) {
				skipped++
			} else {
				target.set(key, e)
			}
		}
	}
	for _, key := range dep.keys {
		if live.has(key) || psBuiltinHas(key) {
			skipped++
		} else {
			live.set(key, dep.m[key])
		}
	}
	return ExtractResult{Entries: live.values(), Skipped: skipped}
}

// SanitizeSyncedEntries：缓存文件条目再校验
func SanitizeSyncedEntries(raw any) []PriceEntry {
	arr, ok := raw.([]any)
	if !ok {
		return []PriceEntry{}
	}
	out := &psOrdered{m: map[string]PriceEntry{}}
	for _, x := range arr {
		o := psObj(x)
		model := ""
		if o != nil {
			if s, ok := o.Get("model").(string); ok {
				model = NormalizeModel(s)
			}
		}
		if o == nil || model == "" || out.has(model) {
			continue
		}
		base := psReadRates(o, "cacheRead", "cacheWrite")
		tiers, tok := psReadTiers(o.Get("tiers"), o.Has("tiers"), "cacheRead", "cacheWrite", func(t *util.Obj) any { return t.Get("size") })
		if base == nil || !tok {
			continue
		}
		e := PriceEntry{Model: model, ModelPrice: ModelPrice{Input: base.input, Output: base.output, CacheRead: base.cacheRead, CacheWrite: base.cacheWrite}}
		if len(tiers) > 0 {
			e.Tiers = tiers
		}
		if s, ok := o.Get("label").(string); ok && s != "" {
			e.Label = strp(s)
		}
		out.set(model, e)
	}
	return out.values()
}

// PriceEntryObj：按 Node 字面量键序输出（model, input, output, cacheRead?, cacheWrite?, tiers?, label?）
func PriceEntryObj(e PriceEntry) *util.Obj {
	o := util.NewObj().Set("model", e.Model).Set("input", e.Input).Set("output", e.Output)
	if e.CacheRead != nil {
		o.Set("cacheRead", *e.CacheRead)
	}
	if e.CacheWrite != nil {
		o.Set("cacheWrite", *e.CacheWrite)
	}
	if e.Tiers != nil {
		ts := make([]any, len(e.Tiers))
		for i, t := range e.Tiers {
			to := util.NewObj().Set("size", t.Size).Set("input", t.Input).Set("output", t.Output)
			if t.CacheRead != nil {
				to.Set("cacheRead", *t.CacheRead)
			}
			if t.CacheWrite != nil {
				to.Set("cacheWrite", *t.CacheWrite)
			}
			ts[i] = to
		}
		o.Set("tiers", ts)
	}
	if e.Label != nil {
		o.Set("label", *e.Label)
	}
	return o
}

type PriceSyncState struct {
	Count     float64 `json:"count"`
	FetchedAt float64 `json:"fetchedAt"`
	CheckedAt float64 `json:"checkedAt"`
	TableDate string  `json:"tableDate"`
}

// PriceSyncResult：ok=true 带 Status/Count/Skipped；否则 Reason（HTTPStatus 仅 http）
type PriceSyncResult struct {
	OK         bool
	Status     string
	Count      int
	Skipped    int
	Reason     string
	HTTPStatus *int
}

func (r PriceSyncResult) Obj() *util.Obj {
	o := util.NewObj().Set("ok", r.OK)
	if r.OK {
		return o.Set("status", r.Status).Set("count", float64(r.Count)).Set("skipped", float64(r.Skipped))
	}
	o.Set("reason", r.Reason)
	if r.HTTPStatus != nil {
		o.Set("httpStatus", float64(*r.HTTPStatus))
	}
	return o
}

type psCache struct {
	etag      *string
	fetchedAt float64
	checkedAt float64
	tableDate string
	entries   []PriceEntry
}

func (c *psCache) obj() *util.Obj {
	es := make([]any, len(c.entries))
	for i, e := range c.entries {
		es[i] = PriceEntryObj(e)
	}
	var etag any
	if c.etag != nil {
		etag = *c.etag
	}
	return util.NewObj().Set("v", 1.0).Set("etag", etag).Set("fetchedAt", c.fetchedAt).Set("checkedAt", c.checkedAt).
		Set("tableDate", c.tableDate).Set("entries", es)
}

// PriceFetch：发请求（默认 = Node 全局 fetch(url, {redirect:'follow', credentials:'omit'}) 的 undici 语义）
type PriceFetch func(req *http.Request) (*http.Response, error)

// psClient：不让 net/http 自己跟随重定向（它会加 Referer、按「子域」规则保留凭据头、上限 10 跳），
// 由 defaultPriceFetch 按 undici httpRedirectFetch 逐跳处理。
var psClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// errFetchFailed：undici 网络错误（String(e) = "TypeError: fetch failed"）
var errFetchFailed = jsrt.JSThrow{Name: "TypeError", Message: "fetch failed"}

// psFetchDefaults：Node 全局 fetch 缺省补的请求头（大小写不敏感判断；规范名写入，否则 net/http 会再补自己的 User-Agent）
func psFetchDefaults(h http.Header) {
	for _, kv := range [][2]string{{"accept", "*/*"}, {"accept-language", "*"}, {"sec-fetch-mode", "cors"}, {"user-agent", "node"}} {
		found := false
		for k := range h {
			if strings.EqualFold(k, kv[0]) {
				found = true
				break
			}
		}
		if !found {
			h.Set(kv[0], kv[1])
		}
	}
}

func psDelHeader(h http.Header, name string) {
	for k := range h {
		if strings.EqualFold(k, name) {
			delete(h, k)
		}
	}
}

func psSameOrigin(a, b *url.URL) bool {
	port := func(u *url.URL) string {
		if p := u.Port(); p != "" {
			return p
		}
		if u.Scheme == "https" {
			return "443"
		}
		return "80"
	}
	return a.Scheme == b.Scheme && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}

// defaultPriceFetch：undici 的重定向规则——301/302/303/307/308 且有 Location 才跟随；第 21 跳网络错误；
// Location 非 http(s) 或解析失败 → 网络错误；303（或 301/302 + POST）改 GET；跨源时删除
// authorization / proxy-authorization / cookie / host（删除是累积的）；不加 Referer。
func defaultPriceFetch(req *http.Request) (*http.Response, error) {
	cur := req.Clone(req.Context())
	psFetchDefaults(cur.Header)
	for count := 0; ; count++ {
		resp, err := psClient.Do(cur)
		if err != nil {
			if req.Context().Err() != nil {
				return nil, req.Context().Err()
			}
			return nil, errFetchFailed
		}
		loc := resp.Header.Get("Location")
		switch resp.StatusCode {
		case 301, 302, 303, 307, 308:
		default:
			loc = ""
		}
		if loc == "" {
			if err := gwnet.DecodeUndiciResponse(cur.Method, resp); err != nil {
				resp.Body.Close()
				return nil, err
			}
			return resp, nil
		}
		resp.Body.Close()
		next, err := cur.URL.Parse(loc)
		if err != nil || (next.Scheme != "http" && next.Scheme != "https") || count == 20 {
			return nil, errFetchFailed
		}
		method := cur.Method
		if resp.StatusCode == 303 && method != http.MethodGet && method != http.MethodHead ||
			(resp.StatusCode == 301 || resp.StatusCode == 302) && method == http.MethodPost {
			method = http.MethodGet
		}
		nr, _ := http.NewRequestWithContext(req.Context(), method, next.String(), nil)
		nr.Header = cur.Header.Clone()
		if !psSameOrigin(cur.URL, next) {
			for _, h := range []string{"authorization", "proxy-authorization", "cookie", "host"} {
				psDelHeader(nr.Header, h)
			}
		}
		cur = nr
	}
}

type PriceSyncDeps struct {
	Root      string
	Now       func() float64
	FetchImpl PriceFetch
	Logger    Logger
	OnData    func(api any) error
	NeedsFull func() bool
	// Timeout：测试注入；0 = 45s
	Timeout time.Duration
}

type PriceSync struct {
	d       PriceSyncDeps
	file    string
	mu      sync.Mutex
	writes  sync.WaitGroup // 仅供测试等待异步写盘（WaitWrites），不改变行为
	cache   *psCache
	running bool
	ver     int
}

func NewPriceSync(d PriceSyncDeps) *PriceSync {
	p := &PriceSync{d: d, file: filepath.Join(d.Root, "price-sync.json")}
	p.load()
	return p
}

func (p *PriceSync) now() float64 {
	if p.d.Now != nil {
		return p.d.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (p *PriceSync) load() {
	st, err := os.Stat(p.file)
	if err != nil || st.Size() > psMaxBodyBytes {
		return
	}
	b, err := os.ReadFile(p.file)
	if err != nil {
		return
	}
	v, err := util.ParseString(utf8Decode(b))
	if err != nil {
		return
	}
	j := psObj(v)
	if j == nil {
		return
	}
	entries := SanitizeSyncedEntries(j.Get("entries"))
	if len(entries) == 0 {
		return
	}
	n := func(v any) float64 {
		if f, ok := v.(float64); ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f > 0 {
			return f
		}
		return 0
	}
	c := &psCache{fetchedAt: n(j.Get("fetchedAt")), checkedAt: n(j.Get("checkedAt")), entries: entries}
	if s, ok := j.Get("etag").(string); ok && s != "" {
		c.etag = &s
	}
	if s, ok := j.Get("tableDate").(string); ok {
		c.tableDate = s
	}
	p.cache = c
}

// utf8Decode：readFileSync(…, 'utf8')（坏字节 → U+FFFD）
func utf8Decode(b []byte) string { return strings.ToValidUTF8(string(b), "\uFFFD") }

func (p *PriceSync) Entries() []PriceEntry {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cache == nil {
		return []PriceEntry{}
	}
	return p.cache.entries
}

func (p *PriceSync) Version() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.ver
}

func (p *PriceSync) State() PriceSyncState {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.cache
	if c == nil {
		return PriceSyncState{}
	}
	return PriceSyncState{Count: float64(len(c.entries)), FetchedAt: c.fetchedAt, CheckedAt: c.checkedAt, TableDate: c.tableDate}
}

func (p *PriceSync) Reset() {
	p.mu.Lock()
	p.cache = nil
	p.ver++
	p.mu.Unlock()
	_ = os.Remove(p.file) // force:true：不存在不报错；其它错误也忽略
}

// WaitWrites 等待已发起的异步缓存写盘完成（测试清理 TempDir 前用）。
func (p *PriceSync) WaitWrites() { p.writes.Wait() }

// save：异步写盘，失败只记日志（调用方持锁）
func (p *PriceSync) save() {
	if p.cache == nil {
		return
	}
	_ = os.MkdirAll(p.d.Root, 0o755)
	pr := utils.WritePrivateFileAtomicAsync(p.file, []byte(util.Stringify(p.cache.obj())))
	p.writes.Add(1)
	go func() {
		defer p.writes.Done()
		<-pr.Done()
		if _, err := pr.Result(); err != nil && p.d.Logger != nil {
			p.d.Logger.Warn("price sync cache write failed", jsString(err))
		}
	}()
}

func psHeader(h http.Header, k string) (string, bool) {
	vs := h.Values(k)
	if len(vs) == 0 {
		return "", false
	}
	return strings.Join(vs, ", "), true
}

func psDateParse(s string, ok bool) (float64, bool) {
	if !ok {
		s = ""
	}
	return reminders.DateParse(s)
}

func psDateOnly(ms float64) string {
	s, _ := util.ToISOString(ms)
	return util.UTF16Slice0(s, 10)
}

// Sync：用户点击或启动时自动同步。失败不动已有缓存。
func (p *PriceSync) Sync() PriceSyncResult {
	p.mu.Lock()
	if p.running {
		p.mu.Unlock()
		return PriceSyncResult{Reason: "busy"}
	}
	p.running = true
	var etag *string
	if p.cache != nil {
		etag = p.cache.etag
	}
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.running = false; p.mu.Unlock() }()

	to := p.d.Timeout
	if to <= 0 {
		to = psTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), to)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, PriceSyncURL, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "br, gzip")
	if etag != nil && !(p.d.NeedsFull != nil && p.d.NeedsFull()) {
		req.Header.Set("If-None-Match", *etag)
	}
	doFetch := p.d.FetchImpl
	if doFetch == nil {
		doFetch = defaultPriceFetch
	}
	warn := func(m string, d string) {
		if p.d.Logger != nil {
			p.d.Logger.Warn(m, d)
		}
	}
	res, err := doFetch(req)
	if err != nil {
		if ctx.Err() != nil {
			warn("price sync failed", psAbortText)
			return PriceSyncResult{Reason: "timeout"}
		}
		warn("price sync failed", jsString(err))
		return PriceSyncResult{Reason: "network"}
	}
	defer res.Body.Close()
	now := p.now()
	p.mu.Lock()
	if res.StatusCode == 304 && p.cache != nil {
		p.cache.checkedAt = now
		p.save()
		p.ver++
		n := len(p.cache.entries)
		p.mu.Unlock()
		return PriceSyncResult{OK: true, Status: "not-modified", Count: n}
	}
	p.mu.Unlock()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		st := res.StatusCode
		return PriceSyncResult{Reason: "http", HTTPStatus: &st}
	}
	cl, _ := psHeader(res.Header, "Content-Length")
	if l := jsToNumber(cl); !math.IsNaN(l) && !math.IsInf(l, 0) && l > psMaxBodyBytes {
		return PriceSyncResult{Reason: "too-large"}
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, psMaxBodyBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			warn("price sync body failed", psAbortText)
			return PriceSyncResult{Reason: "timeout"}
		}
		warn("price sync body failed", "TypeError: terminated")
		return PriceSyncResult{Reason: "network"}
	}
	if len(body) > psMaxBodyBytes {
		return PriceSyncResult{Reason: "too-large"}
	}
	api, err := util.ParseString(utf8Decode(body))
	if err != nil {
		return PriceSyncResult{Reason: "invalid"}
	}
	ex := ExtractPrices(api)
	if len(ex.Entries) < psMinEntries {
		return PriceSyncResult{Reason: "invalid"}
	}
	if p.d.OnData != nil {
		if err := p.d.OnData(api); err != nil {
			warn("models data consumer failed", jsString(err))
		}
	}
	lmS, lmOK := psHeader(res.Header, "Last-Modified")
	dhS, dhOK := psHeader(res.Header, "Date")
	td := now
	if lm, ok := psDateParse(lmS, lmOK); ok {
		td = lm
	} else if dh, ok := psDateParse(dhS, dhOK); ok {
		td = dh
	}
	c := &psCache{fetchedAt: now, checkedAt: now, tableDate: psDateOnly(td), entries: ex.Entries}
	if et, _ := psHeader(res.Header, "Etag"); et != "" {
		c.etag = &et
	}
	p.mu.Lock()
	p.cache = c
	p.ver++
	p.save()
	p.mu.Unlock()
	return PriceSyncResult{OK: true, Status: "updated", Count: len(ex.Entries), Skipped: ex.Skipped}
}

// psAbortText：String(DOMException AbortError)
const psAbortText = "AbortError: This operation was aborted"

// jsString = String(e)：JS 抛出值按 `${name}: ${message}`，其它 Go 错误当作 Error
func jsString(err error) string {
	var t jsrt.JSThrow
	if errors.As(err, &t) {
		if t.Name == "" {
			return "Error: " + t.Message
		}
		return t.Name + ": " + t.Message
	}
	return "Error: " + err.Error()
}
