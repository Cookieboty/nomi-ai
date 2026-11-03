package route

import (
	"reflect"
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
}
