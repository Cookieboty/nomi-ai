// Package llm：主进程用的 LLM 供应商类型与环境变量端点（envEndpoints）。
package llm

// EnvEndpointDefaults：环境变量 provider id → OpenAI 兼容端点默认值（仅预填）
type EnvEndpointDefaults struct {
	BaseURL        string
	Model          string
	RequiresAPIKey bool
}

// EnvEndpointDefaultsByID：ENV_ENDPOINT_DEFAULTS
var EnvEndpointDefaultsByID = map[string]EnvEndpointDefaults{
	"openai":   {"https://api.openai.com/v1", "gpt-4o-mini", true},
	"deepseek": {"https://api.deepseek.com/v1", "deepseek-chat", true},
	"ollama":   {"http://127.0.0.1:11434/v1", "qwen2.5:3b-instruct", false},
	"llamacpp": {"http://127.0.0.1:8080/v1", "local", false},
	"claude":   {"https://api.anthropic.com/v1", "claude-sonnet-4-5", true},
	"gemini":   {"https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", true},
	"qwen":     {"https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", true},
	"doubao":   {"https://ark.cn-beijing.volces.com/api/v3", "doubao-pro", true},
}

// LLMProviderEntry：供应商条目（"" = 未设置）
type LLMProviderEntry struct {
	ID      string
	APIKey  string
	BaseURL string
	Model   string
}
