package usage

import (
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// RecordGateway = UsageService.recordGateway：经统一网关的 Nomi 调用按网关逐次记账（每次上游请求一条）。
// 一轮对话里模型可能被调多次（工具循环），AI SDK 一轮结束时的汇总在部分协议上不全，以网关为准。
// 输入口径与网关请求日志一致：Messages 上游的输入不含缓存读写，其它协议的输入含缓存读，要减掉。
func (s *UsageService) RecordGateway(e *util.Obj) *UsageRecord {
	str := func(k string) string { x, _ := e.Get(k).(string); return x }
	num := func(v any) float64 {
		if x, ok := v.(float64); ok && x > 0 {
			return x
		}
		return 0
	}
	if str("client") != "nomi" {
		return nil
	}
	if st := num(e.Get("status")); st < 200 || st >= 300 {
		return nil
	}
	u, _ := e.Get("usage").(*util.Obj)
	cacheRead, cacheWrite, raw := num(u.Get("cacheReadTokens")), num(u.Get("cacheWriteTokens")), num(u.Get("inputTokens"))
	uncached := raw
	if str("wire") != "messages" {
		uncached = max(0, raw-cacheRead)
	}
	provider, model := str("provider"), str("upstreamModel")
	if model == "" {
		model = str("model")
		if provider != "" && strings.HasPrefix(model, provider+"/") {
			model = model[len(provider)+1:]
		}
	}
	if model == "" {
		model = "unknown"
	}
	ts := num(e.Get("startedAt"))
	dur := num(e.Get("ms"))
	s.seq++
	key := "nomi:gw:" + util.FormatNumber(ts) + ":" + provider + ":" + strconv.Itoa(s.seq)
	return s.Record(UsageInput{Ts: ts, Dur: &dur, Source: "nomi", Via: "chat", Provider: provider, Model: model,
		PromptTokens: uncached + cacheRead + cacheWrite, OutputTokens: num(u.Get("outputTokens")),
		CacheRead: &cacheRead, CacheWrite: &cacheWrite, Key: &key})
}
