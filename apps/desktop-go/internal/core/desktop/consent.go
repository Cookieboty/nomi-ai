package desktop

import (
	"regexp"
	"strings"

	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

// consent.ts：何时需要用户确认（纯函数）

type Danger = string   // read | write | destructive
type Policy = string   // always | session | ask
type PermMode = string // plan | manual | acceptEdits | auto

var DefaultPolicy = map[Danger]Policy{"read": "always", "write": "session", "destructive": "ask"}

var ToolDefaultPolicy = map[string]Policy{
	"clipboard_read": "session",
	"browser_open":   "ask",
	"browser_read":   "ask",
	"browser_click":  "ask",
	"browser_type":   "ask",
}

// SanitizePolicy：p 是 JSON 值（string 或其它）
// 未知 danger 时 Node 返回 undefined（DEFAULT_POLICY 无此键），这里返回 ""；JSON 层由调用方省略
func SanitizePolicy(danger Danger, p any) Policy {
	s, _ := p.(string)
	if s != "always" && s != "session" && s != "ask" {
		return DefaultPolicy[danger]
	}
	if danger == "destructive" {
		return "ask"
	}
	return s
}

type ConsentInput struct {
	Danger         Danger
	Policy         any // nil = 未设
	SessionAllowed bool
	Tainted        bool
	Mode           PermMode
	ExplicitPolicy bool
}

type ConsentDecision struct {
	Blocked      bool   `json:"blocked,omitempty"`
	Confirm      bool   `json:"confirm"`
	Dialog       bool   `json:"dialog"`
	Rememberable bool   `json:"rememberable"`
	Reason       string `json:"reason"`
}

func Decide(i ConsentInput) ConsentDecision {
	mode := i.Mode
	if mode == "" {
		mode = "acceptEdits"
	}
	if mode == "plan" && i.Danger != "read" {
		return ConsentDecision{Blocked: true, Reason: "mode"}
	}
	var pin any = i.Policy
	if pin == nil {
		pin = DefaultPolicy[i.Danger]
	}
	policy := SanitizePolicy(i.Danger, pin)
	if i.Danger == "write" && mode == "manual" {
		policy = "ask"
	}
	if i.Danger == "write" && mode == "auto" && !i.ExplicitPolicy {
		policy = "always"
	}
	if i.Danger == "destructive" {
		return ConsentDecision{Confirm: true, Dialog: true, Reason: "destructive"}
	}
	if i.Danger == "write" && i.Tainted {
		return ConsentDecision{Confirm: true, Reason: "tainted"}
	}
	if policy == "always" || (policy == "session" && i.SessionAllowed) {
		return ConsentDecision{Reason: "auto"}
	}
	if policy == "session" {
		return ConsentDecision{Confirm: true, Rememberable: true, Reason: "first-use"}
	}
	return ConsentDecision{Confirm: true, Reason: "policy"}
}

var re127 = regexp.MustCompile(`^127\.`)

// IsLocalBaseURL：WHATWG hostname 判断本地端点
func IsLocalBaseURL(baseURL string) bool {
	if baseURL == "" {
		return false
	}
	u, err := gnet.ParseURL(baseURL)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	return h == "localhost" || h == "::1" || re127.MatchString(h) || strings.HasSuffix(h, ".local") || h == "0.0.0.0"
}
