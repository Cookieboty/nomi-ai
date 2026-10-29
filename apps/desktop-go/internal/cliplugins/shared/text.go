// text.go mirrors packages/cli-plugins/src/shared/text.ts：会话标题等文本的清理。
package shared

import (
	"regexp"

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

// CleanTitle mirrors cleanTitle (nil = undefined).
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
			a = am[1]
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
