// exec.go：exec 驱动收尾规则的共用部分。
package shared

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// UsageDone：收到用量事件即算完成。
var UsageDone = &clisdk.ExecRules{Completes: func(ev clisdk.Ev) bool {
	return ev.Get("type") == "done" && util.Truthy(ev.Get("usage"))
}}
