package harness

// orchestrator_api.go：contract/coding.ts 直接调用、此前未移植的几个公开方法
// （stopAgent / tabContext / answerPermission / answerApprovePlan）。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// StopAgent = stopAgent：单独停止一个后台子代理（Claude stop_task）；其它 CLI 返回 false。
func (o *Orchestrator) StopAgent(tabID, agentID string) bool {
	live := o.live.claude[tabID]
	m := o.bgAgents[tabID]
	if live == nil || m == nil {
		return false
	}
	if _, ok := m.m[agentID]; !ok {
		return false
	}
	return o.writeClaudeControl(live, util.NewObj("subtype", "stop_task", "task_id", agentID))
}

// TabContext = tabContext：Claude 标签以 CLI 会话记录为准；没有时 null（读盘让出事件循环，同 Node 的 fs.promises）。
func (o *Orchestrator) TabContext(tabID string) *jsrt.Promise[*util.Obj] {
	tab := o.tab(tabID)
	if tab == nil || str(tab, "backend") != "claude" {
		return jsrt.Resolved[*util.Obj](nil)
	}
	sid := strP(tab, "cliSessionId")
	if sid == nil || *sid == "" {
		return jsrt.Resolved[*util.Obj](nil)
	}
	dir := usage.ClaudeConfigDir(o.home, usage.ProcessEnv())
	cwd, s := str(tab, "cwd"), *sid
	return ioAsync(func() *util.Obj { return cli.ClaudeTranscriptContext(dir, cwd, s) })
}

// AnswerPermission = answerPermission：带 approvePlan（三选一）时按计划处理，否则允许 / 拒绝。
func (o *Orchestrator) AnswerPermission(tabID, requestID string, allow bool, approvePlan any) bool {
	if p, ok := approvePlan.(string); ok && (p == "acceptEdits" || p == "manual" || p == "deny") {
		return o.ReplyApprovePlan(tabID, requestID, p)
	}
	return o.replyPermission(tabID, requestID, allow)
}

// AnswerApprovePlan = answerApprovePlan：其他值报错。
func (o *Orchestrator) AnswerApprovePlan(tabID, requestID string, choice any) bool {
	c := util.JSString(choice)
	if c != "acceptEdits" && c != "manual" && c != "deny" {
		throw(i18n.T("electron.common.invalid-approve-plan-choice"))
	}
	return o.ReplyApprovePlan(tabID, requestID, c)
}
