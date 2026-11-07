package cli

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 编程助手子进程的环境变量清理（docs/development/security.md「编程助手」）：
// 从用户环境继承来的凭据（令牌、密码、云账号密钥、数据库连接串）不交给 CLI，
// 模型服务的凭据（CLI 本来就要用）与用户在设置里放行的变量除外。
// 只清继承来的环境；Nomi 自己注入的（标签令牌、官方账号目录）不受影响。

// secretSegments：按 _ 分段后整段命中即算凭据
var secretSegments = map[string]bool{
	"TOKEN": true, "TOKENS": true, "SECRET": true, "SECRETS": true, "PASSWORD": true, "PASSWD": true,
	"CREDENTIAL": true, "CREDENTIALS": true, "APIKEY": true, "PRIVATEKEY": true, "PAT": true, "DSN": true,
}

// secretSubstrings：名字里出现就算（PGPASSWORD 这类不分段的）
var secretSubstrings = []string{"PASSWORD", "SECRET"}

// secretSuffixes：连接串（常带密码）
var secretSuffixes = []string{"DATABASE_URL", "MONGODB_URI", "MONGO_URL", "REDIS_URL", "AMQP_URL"}

// modelEnvPrefixes：模型服务的凭据与配置，编程助手要用，不清
var modelEnvPrefixes = []string{
	"ANTHROPIC_", "CLAUDE_", "OPENAI_", "AZURE_OPENAI_", "CODEX_", "GEMINI_", "GOOGLE_GENAI_", "XAI_", "GROK_",
	"OPENROUTER_", "DEEPSEEK_", "MISTRAL_", "GROQ_", "TOGETHER_", "FIREWORKS_", "DASHSCOPE_", "MOONSHOT_",
	"ZHIPU_", "SILICONFLOW_", "OLLAMA_", "PERPLEXITY_", "DSH_",
}

var modelEnvNames = map[string]bool{"GOOGLE_API_KEY": true}

// IsSecretEnv：变量名看起来是凭据
func IsSecretEnv(name string) bool {
	n := strings.ToUpper(name)
	for _, s := range secretSubstrings {
		if strings.Contains(n, s) {
			return true
		}
	}
	for _, s := range secretSuffixes {
		if n == s || strings.HasSuffix(n, "_"+s) {
			return true
		}
	}
	segs := strings.Split(n, "_")
	for i, s := range segs {
		if secretSegments[s] {
			return true
		}
		// MYSQL_PWD；单独的 PWD / OLDPWD 是当前目录
		if s == "PWD" && len(segs) > 1 {
			return true
		}
		if i > 0 && s == "KEY" {
			return true // API_KEY / ACCESS_KEY / PRIVATE_KEY / SIGNING_KEY…
		}
		if i > 0 && s == "ID" && segs[i-1] == "KEY" {
			return true // AWS_ACCESS_KEY_ID
		}
	}
	return false
}

func isModelEnv(name string, env *util.Obj) bool {
	n := strings.ToUpper(name)
	if modelEnvNames[n] {
		return true
	}
	for _, p := range modelEnvPrefixes {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	// 走 Bedrock / Vertex 的 Claude Code、走 Vertex 的 Gemini 要用云账号
	on := func(k string) bool {
		v, _ := env.Get(k).(string)
		return v != "" && v != "0" && !strings.EqualFold(v, "false")
	}
	if strings.HasPrefix(n, "AWS_") && on("CLAUDE_CODE_USE_BEDROCK") {
		return true
	}
	if (n == "GOOGLE_APPLICATION_CREDENTIALS" || strings.HasPrefix(n, "CLOUD_ML_") || strings.HasPrefix(n, "GOOGLE_CLOUD_")) &&
		(on("CLAUDE_CODE_USE_VERTEX") || on("GOOGLE_GENAI_USE_VERTEXAI")) {
		return true
	}
	return false
}

// ScrubSecretEnv：返回去掉凭据变量的新对象（键序不变）；allow 里的名字（大小写不敏感）原样保留。
// 第二个返回值是去掉的变量名（只记名字，不记值）。
func ScrubSecretEnv(env *util.Obj, allow []string) (*util.Obj, []string) {
	allowed := map[string]bool{}
	for _, a := range allow {
		allowed[strings.ToUpper(strings.TrimSpace(a))] = true
	}
	out := util.NewObj()
	var dropped []string
	for _, k := range env.Keys() {
		v, _ := env.Lookup(k)
		if IsSecretEnv(k) && !allowed[strings.ToUpper(k)] && !isModelEnv(k, env) {
			dropped = append(dropped, k)
			continue
		}
		out.Set(k, v)
	}
	return out, dropped
}
