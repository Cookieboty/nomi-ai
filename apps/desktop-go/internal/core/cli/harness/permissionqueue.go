// Package harness 是 packages/core/src/cli/harness（Orchestrator 及其辅助）的 Go 移植。
package harness

import (
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// NowMs = Date.now()（测试可替换）。
var NowMs = func() float64 { return float64(time.Now().UnixMilli()) }

var exitPlanTools = map[string]bool{"ExitPlanMode": true, "exit_plan_mode": true, "exit-plan-mode": true, "exitPlanMode": true}

var headSplit = util.JSRe(`:|\s`)
var dashUnderscore = regexp.MustCompile(`[_-]`)

// splitHead = s.split(/[:\s]/, 1)[0]。
func splitHead(s string) string {
	if loc := headSplit.FindStringIndex(s); loc != nil {
		return s[:loc[0]]
	}
	return s
}

// IsExitPlanTool = isExitPlanTool（nil/"" = 假）。
func IsExitPlanTool(nameOrSummary string) bool {
	if nameOrSummary == "" {
		return false
	}
	head := util.JSTrim(splitHead(nameOrSummary))
	if exitPlanTools[head] {
		return true
	}
	return dashUnderscore.ReplaceAllString(util.JSLower(head), "") == "exitplanmode"
}

// ApprovePlanMode = approvePlanMode（"" = null）。
func ApprovePlanMode(choice string) string {
	if choice == "acceptEdits" || choice == "manual" {
		return choice
	}
	return ""
}

// WithPermissionExpiry = withPermissionExpiry。
func WithPermissionExpiry(ev *util.Obj, timeoutMs float64) *util.Obj {
	if ev.Get("type") != "permission" {
		return ev
	}
	if _, ok := ev.Lookup("expiresAt"); ok { // util.Obj 不存 undefined：键存在即 !== undefined
		return ev
	}
	o := ev.Clone()
	o.Set("expiresAt", NowMs()+timeoutMs)
	return o
}

// MarkApprovePlanIfExit = markApprovePlanIfExit。
func MarkApprovePlanIfExit(ev *util.Obj) *util.Obj {
	if ev.Get("type") != "permission" {
		return ev
	}
	if k := ev.Get("kind"); k == "approve-plan" || k == "tool" {
		return ev
	}
	tn := ev.Get("toolName")
	name := tn
	if name == nil {
		name = ev.Get("summary")
	}
	ns, _ := name.(string)
	if !IsExitPlanTool(ns) {
		return ev
	}
	o := ev.Clone()
	o.Set("kind", "approve-plan")
	if !util.Truthy(tn) {
		o.Set("toolName", splitHead(ns))
	}
	return o
}

const ExecutePlanIDPrefix = "execute-plan:"
const ExecutePlanFollowUp = "electron.common.implement-the-plan-above"

func IsExecutePlanID(id string) bool { return strings.HasPrefix(id, ExecutePlanIDPrefix) }

// ExecutePlanEvent = executePlanEvent。
func ExecutePlanEvent(turnKey, summary string, timeoutMs float64) *util.Obj {
	return util.NewObj("type", "permission", "id", ExecutePlanIDPrefix+turnKey, "summary", summary,
		"kind", "approve-plan", "toolName", "execute_plan", "expiresAt", NowMs()+timeoutMs)
}
