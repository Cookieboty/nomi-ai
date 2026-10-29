package providers

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func tru() *bool { return u.Ptr(true) }

// Builtin specs (providers/builtin.ts).
var (
	Anthropic = &Spec{ID: "anthropic", Presets: []string{"anthropic"}, Hosts: []string{"api.anthropic.com"}, Native: "anthropic"}
	OpenAI    = &Spec{ID: "openai", Presets: []string{"openai"}, Hosts: []string{"api.openai.com"}, Native: "openai"}
	DeepSeek  = &Spec{ID: "deepseek", Presets: []string{"deepseek"}, Hosts: []string{"api.deepseek.com"},
		Request: &config.ProviderQuirks{ReasoningPassback: tru()}}
	Zhipu = &Spec{ID: "zhipu", Presets: []string{"zhipu", "zhipu-coding"}, Hosts: []string{"open.bigmodel.cn"},
		Request: &config.ProviderQuirks{MaxTools: u.Ptr(128.0), ReasoningPassback: tru()}}
	Kimi = &Spec{ID: "kimi", Presets: []string{"kimi"}, Hosts: []string{"api.moonshot.cn", "api.moonshot.ai"},
		Request: &config.ProviderQuirks{
			DropParams:        []string{"temperature", "top_p", "n", "presence_penalty", "frequency_penalty"},
			ReasoningPassback: tru(),
		}}
	MiniMax = &Spec{ID: "minimax", Presets: []string{"minimax"}, Hosts: []string{"api.minimax.cn", "api.minimaxi.com", "api.minimax.io"},
		Request: &config.ProviderQuirks{
			DropParams:        []string{"service_tier"},
			ReasoningPassback: tru(),
			ExtraBody:         u.NewObj("chat", u.NewObj("reasoning_split", true)),
		}}
	Amux = &Spec{ID: "amux", Presets: []string{"amux"}, Hosts: []string{"gateway.amux.ai"},
		Resp: &Response{
			KeepAlive: []KeepAlive{{Field: "item_id", Equals: "SSE-Keep-Alive"}, {Field: "SSE-Keep-Alive", Equals: true}},
			Events:    map[string]EventRule{"response.metadata": {Drop: true}},
		}}
	Generic = &Spec{ID: "generic"}
)

// BuiltinSpecs is BUILTIN_SPECS.
var BuiltinSpecs = []*Spec{Anthropic, OpenAI, DeepSeek, Zhipu, Kimi, MiniMax, Amux}
