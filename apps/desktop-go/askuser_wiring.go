package main

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/igtools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/askuser"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// askBroker：问题卡（Nomi 的 ask_user 与 Claude Code 的 AskUserQuestion）
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
	o.QuestionHook = func(tabID string, ev *util.Obj) { offerClaudeQuestion(o, tabID, ev) }
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

func notifyAskUserChanged() {
	if f := fleetSvc.Load(); f != nil {
		f.Changed()
	}
	if islandHub != nil {
		islandHub.schedule()
	}
}
