package delegate

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// NomiTaskOf：标签是 Nomi 委派的就返回它的委派任务 id（tabs = harness 的 ListTabs）
func NomiTaskOf(tabs *util.Obj, tabID string) string {
	for _, t := range util.AsArr(tabs.Get("tabs")) {
		if t.Get("id") == tabID {
			if d := delegationOf(t); d != nil && d.Get("by") == "nomi" {
				return util.Str(d.Get("taskId"))
			}
		}
	}
	return ""
}

// ReportFollowUp：委派标签里「委派那一轮之后」又跑完了一轮（用户在子任务里接着对话、沙箱授权后的「请继续」…）：
// 结果同样经 `delegate.completed`（带 followUp）回到来源对话。调用方只传用户自己发的 / 沙箱续跑的轮次（TabFinished.Origin），委派自己的轮次由 finalize 回报。
func (s *Service) ReportFollowUp(taskID string, ok bool, text string, errMsg *string, durationMs float64) {
	base := s.StatusOf(taskID)
	if base == nil {
		return
	}
	res := util.NewObj("taskId", taskID, "cli", base.Get("cli"), "status", "done", "followUp", true)
	if !ok {
		res.Set("status", "error")
		if errMsg != nil {
			res.Set("error", *errMsg)
		}
	}
	if report := ParseDelegateReport(text); report != nil {
		res.Set("report", wrapReport(report, nil))
		res.Set("summary", "")
	} else {
		res.Set("summary", Untrusted(TailText(text, 3000)))
	}
	res.Set("filesVerified", false)
	res.Set("approvals", s.approvalsOf(taskID).Clone())
	res.Set("durationMs", durationMs)
	if cid, ok := base.Get("conversationId").(string); ok && cid != "" {
		res.Set("conversationId", cid)
	}
	s.d.Events.Publish("delegate.completed", res)
}
