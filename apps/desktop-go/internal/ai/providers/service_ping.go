package providers

// ProviderService 的 test / testDraft / fetchModels / fetchModelsDraft
// —— 对应 apps/desktop-electron/internal/ai-runtime/src/providers/ProviderService.ts 同名方法。

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// serviceNow：Date.now（测试钉住）
var serviceNow = time.Now

func (s *Service) testTimeout() time.Duration {
	if s.opts.TestTimeout > 0 {
		return s.opts.TestTimeout
	}
	return 15 * time.Second
}

func (s *Service) findProvider(id string) *u.Obj {
	for _, p := range s.opts.Store.Providers() {
		if jsString(p.Get("id")) == id {
			return p
		}
	}
	return nil
}

func firstKey(keys []string) string {
	if len(keys) > 0 {
		return keys[0]
	}
	return ""
}

type listCfg struct {
	protocol  string
	baseURL   string
	fullURL   bool
	headers   *u.Obj
	userAgent string
}

// FetchModels：fetchModels(id) —— 拉取上游模型列表并缓存到 provider.fetchedModels
func (s *Service) FetchModels(id string) (*u.Obj, error) {
	p := s.findProvider(id)
	if p == nil {
		return nil, fmt.Errorf("provider '%s' 不存在", id)
	}
	keys, err := s.opts.Store.ResolveKeys(id)
	if err != nil {
		return nil, err
	}
	cfg := listCfg{}
	cfg.protocol, _ = p.Get("protocol").(string)
	cfg.baseURL, _ = p.Get("baseURL").(string)
	cfg.fullURL, _ = p.Get("fullUrl").(bool)
	cfg.headers, _ = p.Get("headers").(*u.Obj)
	cfg.userAgent, _ = p.Get("userAgent").(string)
	res := s.listModels(cfg, firstKey(keys))
	if res.Get("ok") == true {
		if _, err := s.opts.Store.SetModels(id, u.NewObj("fetched", res.Get("models"))); err != nil {
			return nil, err
		}
	}
	return res, nil
}

// FetchModelsDraft：fetchModelsDraft(input)
func (s *Service) FetchModelsDraft(input *u.Obj) (*u.Obj, error) {
	cfg, err := s.draftConfig(input)
	if err != nil {
		return nil, err
	}
	lc := listCfg{protocol: cfg.Protocol, baseURL: cfg.BaseURL, userAgent: cfg.UserAgent}
	if cfg.FullURL != nil {
		lc.fullURL = *cfg.FullURL
	}
	lc.headers, _ = cfg.Headers.(*u.Obj)
	return s.listModels(lc, cfg.APIKey), nil
}

func (s *Service) listModels(cfg listCfg, apiKey string) *u.Obj {
	url := protocol.ModelsURL(protocol.Protocol(cfg.protocol), cfg.baseURL, cfg.fullURL)
	t0 := serviceNow()
	extra := u.NewObj()
	if cfg.headers != nil {
		extra.Assign(cfg.headers)
	}
	if cfg.userAgent != "" {
		extra.Set("User-Agent", cfg.userAgent)
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.testTimeout())
	defer cancel()
	models, err := s.fetchModelList(ctx, url, protocol.ModelsRequestHeaders(protocol.Protocol(cfg.protocol), apiKey, extra))
	if err == nil {
		return u.NewObj("ok", true, "latencyMs", msSince(t0, serviceNow()), "url", url, "models", models)
	}
	msg := err.Error()
	if ctx.Err() != nil {
		msg = "超时"
	}
	var secrets []string
	if apiKey != "" {
		secrets = []string{apiKey}
	}
	return u.NewObj("ok", false, "latencyMs", msSince(t0, serviceNow()), "url", url,
		"models", []any{}, "error", RedactSecrets(msg, secrets))
}

func (s *Service) fetchModelList(ctx context.Context, url string, headers *u.Obj) ([]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		// new Request() 抛 TypeError: Failed to parse URL from …
		return nil, fmt.Errorf("Failed to parse URL from %s", url)
	}
	for _, k := range headers.Keys() {
		req.Header.Set(k, jsString(headers.Get(k)))
	}
	c := s.opts.Client
	if c == nil {
		c = http.DefaultClient
	}
	r, err := c.Do(req)
	if err != nil {
		// undici：TypeError('fetch failed')
		return nil, fmt.Errorf("fetch failed")
	}
	defer r.Body.Close()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("terminated")
	}
	text := string(b)
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return nil, fmt.Errorf("HTTP %d: %s", r.StatusCode, u.UTF16Slice0(text, 200))
	}
	if _, perr := charcontract.ParseJSON(text); perr != nil {
		return nil, perr
	}
	root, err := u.ParseString(text)
	if err != nil {
		return nil, err
	}
	return protocol.ParseModelList(root), nil
}

// nn：a ?? b ?? …（nil / undefined 跳过）
func nn(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			if _, ok := v.(u.JSUndefined); !ok {
				return v
			}
		}
	}
	return nil
}

func getOf(o *u.Obj, k string) any {
	if o == nil {
		return nil
	}
	return o.Get(k)
}

func truthyStr(v any) string {
	s, _ := v.(string)
	return s
}

// draftConfig：表单草稿 → 完整连接配置（缺省值来自预设 / 已保存的 provider）
func (s *Service) draftConfig(input *u.Obj) (aisdk.Options, error) {
	var saved *u.Obj
	if id := truthyStr(input.Get("id")); id != "" {
		saved = s.findProvider(id)
	}
	preset := FindPreset(nn(input.Get("presetId"), getOf(saved, "presetId")))
	if preset == nil {
		preset = FindPreset("custom")
	}
	apiKey := strings.TrimSpace(truthyStr(input.Get("apiKey")))
	if apiKey == "" && saved != nil {
		keys, err := s.opts.Store.ResolveKeys(jsString(saved.Get("id")))
		if err != nil {
			return aisdk.Options{}, err
		}
		apiKey = firstKey(keys)
	}
	o := aisdk.Options{ID: "connectivity-test", APIKey: apiKey, RequiresAPIKey: boolPtr(false)}
	o.Protocol = jsString(nn(input.Get("protocol"), getOf(saved, "protocol"), preset.Get("protocol")))
	o.BaseURL = trimTrailingSlashes(strings.TrimSpace(jsString(nn(input.Get("baseURL"), getOf(saved, "baseURL"), preset.Get("baseURL")))))
	full, _ := nn(input.Get("fullUrl"), getOf(saved, "fullUrl"), false).(bool)
	o.FullURL = &full
	o.DefaultModel = strings.TrimSpace(truthyStr(input.Get("defaultModel")))
	for _, v := range []any{getOf(saved, "defaultModel"), preset.Get("defaultModel"), "default"} {
		if o.DefaultModel != "" {
			break
		}
		o.DefaultModel = truthyStr(v)
	}
	o.ModelMap, _ = nn(input.Get("modelMap"), getOf(saved, "modelMap")).([]any)
	if h, ok := nn(input.Get("headers"), getOf(saved, "headers")).(*u.Obj); ok {
		o.Headers = h
	}
	o.UserAgent = truthyStr(nn(input.Get("userAgent"), getOf(saved, "userAgent")))
	if b, ok := nn(input.Get("thinking"), getOf(saved, "thinking")).(bool); ok {
		o.Thinking = &b
	}
	return o, nil
}

func trimTrailingSlashes(s string) string { return strings.TrimRight(s, "/") }

func pingRequest(provider, model string) *blm.ChatRequest {
	mt := 16.0
	st := false
	return &blm.ChatRequest{
		ReqID:     fmt.Sprintf("test-%d", serviceNow().UnixMilli()),
		Provider:  provider,
		Model:     model,
		Messages:  []blm.ChatMessage{{Role: "user", Content: "ping"}},
		MaxTokens: &mt,
		Stream:    &st,
	}
}

// Test：test(id, keyId?) —— 测试已保存 provider 的某个 key（默认主 key）
func (s *Service) Test(id string, keyID string) (*u.Obj, error) {
	p := s.findProvider(id)
	if p == nil {
		// env provider：走 registry 里的实例
		var prov blm.LLMProvider
		if s.opts.GetRegistry != nil {
			if reg := s.opts.GetRegistry(); reg != nil {
				prov = reg.Get(id)
			}
		}
		if prov == nil {
			return nil, fmt.Errorf("provider '%s' 不存在", id)
		}
		req := pingRequest(id, "default")
		return s.ping(func(ctx context.Context) (*blm.ChatResponse, error) { return prov.Chat(ctx, req) }, nil), nil
	}
	keys, err := s.opts.Store.ResolveKeys(id)
	if err != nil {
		return nil, err
	}
	idx := 0
	if keyID != "" {
		idx = -1
		pk, _ := p.Get("keys").([]any)
		for i, k := range pk {
			if ko, ok := k.(*u.Obj); ok && jsString(ko.Get("id")) == keyID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return nil, fmt.Errorf("key '%s' 不存在", keyID)
		}
	}
	apiKey := ""
	if idx < len(keys) {
		apiKey = keys[idx]
	}
	o := StoredOptions(p)
	o.ID = "connectivity-test"
	o.APIKey = apiKey
	o.RequiresAPIKey = boolPtr(false)
	var secrets []string
	if apiKey != "" {
		secrets = []string{apiKey}
	}
	res := s.pingWith(o, secrets)
	var em any = u.JSUndefined{}
	if res.Get("ok") != true {
		em = res.Get("error")
	}
	s.opts.Store.MarkKey(id, float64(idx), em)
	return res, nil
}

// TestDraft：testDraft(input) —— 测试 / 测速尚未保存的草稿
func (s *Service) TestDraft(input *u.Obj) (*u.Obj, error) {
	cfg, err := s.draftConfig(input)
	if err != nil {
		return nil, err
	}
	var secrets []string
	if cfg.APIKey != "" {
		secrets = []string{cfg.APIKey}
	}
	return s.pingWith(cfg, secrets), nil
}

func (s *Service) pingWith(cfg aisdk.Options, secrets []string) *u.Obj {
	factory := s.opts.Factory
	if factory == nil {
		factory = DefaultProviderFactory
	}
	var endpoint any = u.JSUndefined{}
	if cfg.BaseURL != "" {
		proto := cfg.Protocol
		if proto == "" {
			proto = "openai-chat"
		}
		full := cfg.FullURL != nil && *cfg.FullURL
		endpoint = protocol.EndpointURL(protocol.Protocol(proto), cfg.BaseURL, full)
	}
	provider, err := factory(cfg)
	if err != nil {
		return u.NewObj("ok", false, "latencyMs", 0.0, "endpoint", endpoint, "error", RedactSecrets(err.Error(), secrets))
	}
	// cfg.defaultModel ?? 'default'：已保存 provider 的 defaultModel 恒为字符串（可为 ""），草稿恒非空
	req := pingRequest("connectivity-test", cfg.DefaultModel)
	res := s.ping(func(ctx context.Context) (*blm.ChatResponse, error) { return provider.Chat(ctx, req) }, secrets)
	res.Set("endpoint", endpoint)
	if m := res.Get("model"); m == nil {
		res.Set("model", cfg.DefaultModel)
	}
	return res
}

func (s *Service) ping(run func(ctx context.Context) (*blm.ChatResponse, error), secrets []string) *u.Obj {
	t0 := serviceNow()
	timeout := s.testTimeout()
	type out struct {
		res *blm.ChatResponse
		err error
	}
	ch := make(chan out, 1)
	// 超时后取消请求：否则上游一直不回时，请求和它的 goroutine 在界面报超时后还挂着
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		defer func() {
			if r := recover(); r != nil {
				ch <- out{err: fmt.Errorf("%v", r)}
			}
		}()
		r, e := run(ctx)
		ch <- out{r, e}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var o out
	select {
	case o = <-ch:
	case <-timer.C:
		o.err = fmt.Errorf("超时（%dms）", timeout.Milliseconds())
	}
	if o.err != nil {
		return u.NewObj("ok", false, "latencyMs", msSince(t0, serviceNow()), "error", RedactSecrets(o.err.Error(), secrets))
	}
	// LLMProvider.chat 的 ChatResponse.model 恒为字符串
	var model any = u.JSUndefined{}
	content := ""
	if o.res != nil {
		model = o.res.Model
		content = o.res.Content
	}
	return u.NewObj("ok", true, "latencyMs", msSince(t0, serviceNow()), "model", model, "sample", u.UTF16Slice0(content, 40))
}
