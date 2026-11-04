package route

import (
	"reflect"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func fp(id, url string, enabled bool, models ...config.RuntimeModel) config.RuntimeProvider {
	return config.RuntimeProvider{ID: id, Name: id, Enabled: enabled, URLs: u.NewObj("chat", url), Models: models}
}

func ids(ts []FailoverTarget) []string {
	out := []string{}
	for _, x := range ts {
		out = append(out, x.Provider.ID+"/"+x.Model)
	}
	return out
}

// §7.2：同一个模型、按列表顺序换供应商；不换成别的模型；本机首选只回退到本机
func TestFailoverTargets(t *testing.T) {
	on := func(id string) config.RuntimeModel { return config.RuntimeModel{ID: id, Enabled: true} }
	cfg := &config.GatewayConfig{Providers: []config.RuntimeProvider{
		fp("a", "https://a.example/v1", true, on("claude-opus-4-8")),
		fp("off", "https://off.example/v1", false, on("claude-opus-4-8")),
		fp("unchecked", "https://u.example/v1", true, config.RuntimeModel{ID: "claude-opus-4-8"}),
		fp("other", "https://o.example/v1", true, on("claude-haiku-4-5")),
		fp("c", "https://c.example/v1", true, on("claude-opus-4-8-20260101")),
		fp("b", "https://b.example/v1", true, on("anthropic/claude-opus-4-8")),
	}}
	got := ids(FailoverTargets(cfg, &cfg.Providers[0], "claude-opus-4-8"))
	if want := []string{"c/claude-opus-4-8-20260101", "b/anthropic/claude-opus-4-8"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if k := SameModelKey("OpenAI/GPT-5:free"); k != "gpt-5" {
		t.Fatal(k)
	}

	local := &config.GatewayConfig{Providers: []config.RuntimeProvider{
		fp("local", "http://127.0.0.1:11434/v1", true, on("qwen3")),
		fp("cloud", "https://cloud.example/v1", true, on("qwen3")),
		fp("lan", "http://192.168.1.5:1234/v1", true, on("qwen3")),
	}}
	if got := ids(FailoverTargets(local, &local.Providers[0], "qwen3")); !reflect.DeepEqual(got, []string{"lan/qwen3"}) {
		t.Fatalf("local failed over to %v", got)
	}
	if got := ids(FailoverTargets(local, &local.Providers[1], "qwen3")); !reflect.DeepEqual(got, []string{"local/qwen3", "lan/qwen3"}) {
		t.Fatalf("cloud failover %v", got)
	}

	// #248：普通域名解析到局域网、用户确认过的 host:port 也算本机 / 局域网
	dns := &config.GatewayConfig{AllowedPrivateHosts: []string{"llm.company.example:443"}, Providers: []config.RuntimeProvider{
		fp("intranet", "https://llm.company.example/v1", true, on("qwen3")),
		fp("cloud", "https://cloud.example/v1", true, on("qwen3")),
		fp("lan", "http://192.168.1.5:1234/v1", true, on("qwen3")),
	}}
	if got := ids(FailoverTargets(dns, &dns.Providers[0], "qwen3")); !reflect.DeepEqual(got, []string{"lan/qwen3"}) {
		t.Fatalf("intranet DNS failed over to %v", got)
	}
	if got := ids(FailoverTargets(dns, &dns.Providers[2], "qwen3")); !reflect.DeepEqual(got, []string{"intranet/qwen3"}) {
		t.Fatalf("lan failover %v", got)
	}
}

// 停用的供应商自己不出候选：显式请求与客户端分配都直接回退到同一个模型的下一家
func TestDisabledProviderFailsOver(t *testing.T) {
	on := config.RuntimeModel{ID: "m", Enabled: true}
	a := fp("a", "https://a.example/v1", false, on)
	a.Aliases = []string{"old-a"}
	a.Keys = []config.RuntimeKey{{ID: "k", Value: "v", Enabled: true}}
	b := fp("b", "https://b.example/v1", true, on)
	b.Keys = []config.RuntimeKey{{ID: "k", Value: "v", Enabled: true}}
	main := "a/m"
	cfg := &config.GatewayConfig{Providers: []config.RuntimeProvider{a, b},
		Clients: map[string]*config.ClientRuntime{"claude": {Token: "t", Models: config.ClientModels{Main: &main}}}}
	pub := func(r *ResolveResult) []string {
		out := []string{}
		for _, c := range r.Candidates {
			out = append(out, c.PublicModel)
		}
		return out
	}
	if r := ResolveCandidates(cfg, "claude", "old-a/m", "chat", nil); !r.OK || !reflect.DeepEqual(pub(r), []string{"b/m"}) {
		t.Fatalf("explicit: %+v", r)
	}
	if r := ResolveCandidates(cfg, "claude", "", "chat", nil); !r.OK || !reflect.DeepEqual(pub(r), []string{"b/m"}) {
		t.Fatalf("mapped: %+v", r)
	}
	only := &config.GatewayConfig{Providers: []config.RuntimeProvider{a}}
	if r := ResolveCandidates(only, "claude", "a/m", "chat", nil); r.OK || r.Status != 400 || !strings.Contains(r.Message, "已停用") {
		t.Fatalf("none: %+v", r)
	}
}
