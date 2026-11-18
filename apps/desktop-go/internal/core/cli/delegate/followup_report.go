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
//
// 这一轮改过的文件（汇报里列的 + 这一轮改文件的工具事件）也带回去：原来只回报文字，
// 来源对话（和那边的 Nomi）不知道子任务改了什么。失败 / 被停下的一轮已经改了的同样带上。
func (s *Service) ReportFollowUp(taskID, tabID string, ok bool, text string, errMsg *string, durationMs float64) {
	base := s.StatusOf(taskID)
	if base == nil {
		return
	}
	res := util.NewObj("taskId", taskID, "cli", base.Get("cli"), "status", "done", "followUp", true)
	if tabID != "" {
		res.Set("tabId", tabID)
	}
	if !ok {
		res.Set("status", "error")
		if errMsg != nil {
			res.Set("error", *errMsg)
		}
	}
	report := ParseDelegateReport(text)
	var changed []string
	if report != nil {
		changed = strList(report.Get("changedFiles"))
	}
	cwd := ""
	if tabID != "" {
		if tab := s.findTab(tabID); tab != nil {
			cwd = util.Str(tab.Get("cwd"))
		}
		// 这一轮从用户那条消息算起（多留 1 秒余量）；不知道用时就不认工具事件，免得把更早的轮次算进来
		if durationMs > 0 {
			now := s.d.Now()
			changed = mergeFiles(changed, s.edits().Since(tabID, cwd, now-durationMs-1000, now))
		}
	}
	changed = head(changed, 50)
	if report != nil {
		res.Set("report", wrapReport(report, changed))
		res.Set("summary", "")
	} else {
		res.Set("summary", Untrusted(TailText(text, 3000)))
	}
	if len(changed) > 0 {
		res.Set("changedFiles", toAnyList(changed))
		if cwd != "" {
			res.Set("cwd", cwd)
		}
	}
	res.Set("filesVerified", false)
	res.Set("approvals", s.approvalsOf(taskID).Clone())
	if durationMs > 0 {
		res.Set("startedAt", s.d.Now()-durationMs)
	}
	res.Set("durationMs", durationMs)
	if cid, ok := base.Get("conversationId").(string); ok && cid != "" {
		res.Set("conversationId", cid)
	}
	s.d.Events.Publish("delegate.completed", res)
}
