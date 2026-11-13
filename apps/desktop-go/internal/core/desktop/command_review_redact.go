package desktop

// 命令审核发给辅助模型之前，先把命令、工作目录和用户原文里的凭据 / 密钥和本机主目录打码。
// 规则宁严勿松，但不能保证找出所有秘密（未命名的随机串不会动）。

import (
	"os"
	"regexp"
	"strings"
)

const reviewRedacted = "***"

// reviewHome：主目录替换成 ~（测试可改）。空 = 不替换路径。
var reviewHome = func() string {
	h, err := os.UserHomeDir()
	if err != nil || len(h) < 2 {
		return ""
	}
	return h
}()

// secretAssign：--api-key=… / TOKEN=… / client_secret: …（含引号里的值）
var secretAssign = regexp.MustCompile(`(?i)((?:^|[\s"'\\;,&])(?:-{0,2})[\w.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|app(?:lication)?[_-]?secret|secret|password|passwd|authorization|credential|bearer|token)[\w.-]*\s*[=:])\s*(?:Bearer\s+\S+|"[^"]*"|'[^']*'|\S+)`)

// secretFlagSpace：--api-key VALUE / --token VALUE（下一个参数是值）
var secretFlagSpace = regexp.MustCompile(`(?i)((?:^|\s)(?:-{1,2}[\w.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|authorization|credential|token))(?:\s+))(?:"[^"]*"|'[^']*'|\S+)`)

// secretValue：没有参数名、但形状像常见令牌的片段
var secretValue = regexp.MustCompile(
	`(?i)\b(?:` +
		`Bearer\s+[A-Za-z0-9._~+/=-]{8,}` +
		`|sk-[A-Za-z0-9_-]{8,}` +
		`|AIza[0-9A-Za-z_-]{20,}` +
		`|(?:xai|gsk|ghp|gho|github_pat|glpat|hf)_[A-Za-z0-9_]{8,}` +
		`|AKIA[0-9A-Z]{16}` +
		`|xox[baprs]-[A-Za-z0-9-]{10,}` +
		`|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{10,}` + // JWT
		`|(?:[?&](?:key|api_key|access_token|refresh_token|token|client_secret)=)[^&\s"']+` +
		`)`,
)

// RedactReviewSecrets：发出审核请求前的打码（凭据、令牌、主目录路径）。
func RedactReviewSecrets(s string) string {
	if s == "" {
		return s
	}
	out := s
	if home := reviewHome; home != "" {
		out = strings.ReplaceAll(out, home, "~")
	}
	out = secretAssign.ReplaceAllStringFunc(out, func(m string) string {
		parts := secretAssign.FindStringSubmatch(m)
		if len(parts) < 2 {
			return reviewRedacted
		}
		return parts[1] + reviewRedacted
	})
	out = secretFlagSpace.ReplaceAllStringFunc(out, func(m string) string {
		parts := secretFlagSpace.FindStringSubmatch(m)
		if len(parts) < 2 {
			return reviewRedacted
		}
		return parts[1] + reviewRedacted
	})
	out = secretValue.ReplaceAllStringFunc(out, func(m string) string {
		// 保留 query 前缀 key=、以及 Bearer 单词，只打码值
		if i := strings.IndexByte(m, '='); i >= 0 && (strings.HasPrefix(m, "?") || strings.HasPrefix(m, "&")) {
			return m[:i+1] + reviewRedacted
		}
		if len(m) >= 7 && strings.EqualFold(m[:6], "Bearer") && (m[6] == ' ' || m[6] == '\t') {
			return m[:7] + reviewRedacted
		}
		return reviewRedacted
	})
	return out
}
