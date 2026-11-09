// text.go：会话标题等文本的清理。
package shared

import (
	"encoding/json"
	"regexp"
	"strings"

	. "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var (
	reTitleWrap  = regexp.MustCompile(`^` + util.JSWhitespace + `*<(command-name|local-command-stdout|command-message|system-reminder)`)
	reCmdName    = regexp.MustCompile(`<command-name>([^<]+)</command-name>`)
	reCmdArgs    = regexp.MustCompile(`<command-args>([^<]*)</command-args>`)
	reCodexBlock = regexp.MustCompile(`(?i)^` + util.JSWhitespace + `*<(environment_context|user_instructions|INSTRUCTIONS)`)
	reAgentsMd   = regexp.MustCompile(`(?i)^` + util.JSWhitespace + `*#` + util.JSWhitespace + `*AGENTS\.md`)
)

// CleanTitle cleans a session title (nil = undefined).
func CleanTitle(raw string, max int) *string {
	if raw == "" {
		return nil
	}
	s := StripCarriedContext(raw)
	if reTitleWrap.MatchString(s) {
		m := reCmdName.FindStringSubmatch(s)
		if m == nil {
			return nil
		}
		a := ""
		if am := reCmdArgs.FindStringSubmatch(s); am != nil {
			a = JSTrim(am[1])
		}
		// 不带参数的斜杠命令（/clear、/model…）说明不了会话在干什么，不当标题，让调用方往后找真正的提问
		if a == "" {
			return nil
		}
		s = m[1] + " " + a
	}
	if reCodexBlock.MatchString(util.JSIText(s)) || reAgentsMd.MatchString(util.JSIText(s)) {
		return nil
	}
	s = JSTrim(CollapseWS(s, " "))
	if s == "" {
		return nil
	}
	if Len(s) > max {
		s = Slice0(s, max-1) + "…"
	}
	return &s
}

// JSONString：JSON 带引号字符串。也是合法的 TOML 基本字符串与 YAML 双引号字符串（写 CLI 的私有配置用）
func JSONString(s string) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSuffix(b.String(), "\n")
}

// TomlString：TOML 基本字符串（同 JSONString）
func TomlString(s string) string { return JSONString(s) }
