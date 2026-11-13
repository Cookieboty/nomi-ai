package main

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/igtools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/askuser"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// askBroker：问题卡（Nomi 的 ask_user、Claude Code、Codex 与 ACP 的结构化提问）
var askBroker *askuser.Broker

func wireAskUser(router *contract.Router) {
	askBroker = askuser.New(askuser.Options{
		Emit: func(ev askuser.Event) {
			if router != nil {
				router.EmitTo("ai.userQuestion", ev, "chat")
			}
		},
		Changed: notifyAskUserChanged,
	})
	askuser.Register(router, askBroker)
	igtools.SetAskBroker(askBroker)
}

func bindAskUserHarness(o *harness.Orchestrator) {
	if o == nil || askBroker == nil {
		return
	}
	o.QuestionHook = func(tabID string, ev *util.Obj) {
		switch util.Str(ev.Get("protocol")) {
		case "codex":
			offerCodexQuestion(o, tabID, ev)
		case "acp":
			offerAcpQuestion(o, tabID, ev)
		default:
			offerClaudeQuestion(o, tabID, ev)
		}
	}
	o.OnQuestionsCleared = func(tabID string) { askBroker.CancelTab(tabID, true) }
}

func offerClaudeQuestion(o *harness.Orchestrator, tabID string, ev *util.Obj) {
	id := util.Str(ev.Get("id"))
	in := util.AsObj(ev.Get("input"))
	qs, ok := askuser.QuestionsFromClaude(in)
	if id == "" || !ok {
		o.ReplyClaudeQuestion(tabID, id, false, nil, "denied")
		return
	}
	raw := in.Clone()
	if !askBroker.Offer(id, askuser.SourceClaude, "", tabID, qs, func(res askuser.Result) {
		allow := res.Action == askuser.ActionAnswer
		reason := "denied"
		var updated *util.Obj
		if allow {
			updated = askuser.ClaudeUpdatedInput(raw, qs, res)
			reason = "allowed"
		} else if res.Action == askuser.ActionTimeout {
			reason = "timeout"
		}
		o.ReplyClaudeQuestion(tabID, id, allow, updated, reason)
	}) {
		o.ReplyClaudeQuestion(tabID, id, false, nil, "denied")
	}
}

func offerCodexQuestion(o *harness.Orchestrator, tabID string, ev *util.Obj) {
	id := util.Str(ev.Get("id"))
	params := util.AsObj(ev.Get("params"))
	if util.Str(ev.Get("method")) == "mcpServer/elicitation/request" {
		offerElicitation(o, tabID, id, askuser.SourceCodex, params)
		return
	}
	parsed, ok := askuser.QuestionsFromCodex(params)
	if id == "" || !ok {
		// 没有可展示的题（全是机密，或对不上）：空答案让这一轮继续，不要挂住
		body, cancel := askuser.CodexUserInputResult(askuser.CodexUserInput{}, askuser.Result{Action: askuser.ActionSkip})
		o.ReplyLiveQuestion(tabID, id, body, cancel)
		return
	}
	askBroker.Offer(id, askuser.SourceCodex, "", tabID, parsed.Questions, func(res askuser.Result) {
		body, cancel := askuser.CodexUserInputResult(parsed, res)
		o.ReplyLiveQuestion(tabID, id, body, cancel)
	})
}

func offerAcpQuestion(o *harness.Orchestrator, tabID string, ev *util.Obj) {
	offerElicitation(o, tabID, util.Str(ev.Get("id")), askuser.SourceAcp, util.AsObj(ev.Get("params")))
}

func offerElicitation(o *harness.Orchestrator, tabID, id, source string, params *util.Obj) {
	form, ok := askuser.QuestionsFromElicitation(params)
	if id == "" || !ok {
		o.ReplyLiveQuestion(tabID, id, askuser.ElicitationResult(askuser.ElicitationForm{}, askuser.Result{Action: askuser.ActionCancel}), false)
		return
	}
	askBroker.Offer(id, source, "", tabID, form.Questions, func(res askuser.Result) {
		o.ReplyLiveQuestion(tabID, id, askuser.ElicitationResult(form, res), false)
	})
}

func notifyAskUserChanged() {
	if f := fleetSvc.Load(); f != nil {
		f.Changed()
	}
	if islandHub != nil {
		islandHub.schedule()
	}
}
