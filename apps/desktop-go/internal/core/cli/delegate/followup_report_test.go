package delegate

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 委派之后在子任务里接着跑的轮次：结果带 followUp 经 delegate.completed 回到来源对话
func TestReportFollowUp(t *testing.T) {
	e := newTaskEnv(t, util.NewObj(), nil)
	res := util.NewObj("taskId", "t1", "cli", "codex", "status", "done", "conversationId", "conv_1")
	e.svc.mu.Lock()
	e.svc.tasks["t1"] = &bgTask{o: util.NewObj("taskId", "t1", "cli", "codex", "status", "done", "result", res)}
	e.svc.mu.Unlock()

	e.svc.ReportFollowUp("t1", "", true, "fixed the failing test", nil, 1234)
	errMsg := "boom"
	e.svc.ReportFollowUp("t1", "", false, "", &errMsg, 10)
	e.svc.ReportFollowUp("missing", "", true, "x", nil, 1)

	e.log.mu.Lock()
	defer e.log.mu.Unlock()
	if len(e.log.events) != 2 {
		t.Fatalf("events = %v", util.Stringify(e.log.events))
	}
	ok := arr(e.log.events[0])[1].(*util.Obj)
	if arr(e.log.events[0])[0] != "delegate.completed" || ok.Get("followUp") != true || ok.Get("status") != "done" ||
		ok.Get("conversationId") != "conv_1" || ok.Get("cli") != "codex" || ok.Get("durationMs") != 1234.0 ||
		util.Str(ok.Get("summary")) == "" {
		t.Fatalf("follow-up = %v", util.Stringify(ok))
	}
	bad := arr(e.log.events[1])[1].(*util.Obj)
	if bad.Get("status") != "error" || bad.Get("error") != "boom" {
		t.Fatalf("failed follow-up = %v", util.Stringify(bad))
	}
}

// 接着对话的一轮改了文件：改动（汇报里列的 + 这一轮改文件的工具事件）跟着回到来源对话，
// 原来只回报文字（汇报里列的文件也被 wrapReport(report, nil) 清空了）
func TestReportFollowUpCarriesChangedFiles(t *testing.T) {
	e := newTaskEnv(t, util.NewObj(), nil)
	res := util.NewObj("taskId", "t1", "cli", "claude", "status", "done", "conversationId", "conv_1")
	e.svc.mu.Lock()
	e.svc.tasks["t1"] = &bgTask{o: util.NewObj("taskId", "t1", "cli", "claude", "status", "done", "result", res)}
	e.svc.mu.Unlock()
	cwd := filepath.Join(e.dir, "repo")
	e.h.mu.Lock()
	e.h.tabs = append(e.h.tabs, util.NewObj("id", "tab_1", "cwd", cwd))
	e.h.mu.Unlock()
	now := e.svc.d.Now()
	// 更早一轮改的不算；这一轮改的按标签目录转成相对路径
	e.edits.Note("tab_1", []string{filepath.Join(cwd, "old.go")}, now-60_000)
	e.edits.Note("tab_1", []string{filepath.Join(cwd, "internal", "upstream_protocol.go")}, now-2_000)
	e.edits.Note("tab_1", []string{filepath.Join(cwd, "internal", "upstream_protocol_test.go")}, now-1_000)

	e.svc.ReportFollowUp("t1", "tab_1", true, "改好了，加了测试", nil, 5_000)
	report := "[nomi-report]\n做了什么：修了协议\n改动的文件：\n- README.md\n[/nomi-report]"
	e.svc.ReportFollowUp("t1", "tab_1", true, report, nil, 5_000)
	errMsg := "stopped"
	e.svc.ReportFollowUp("t1", "tab_1", false, "", &errMsg, 5_000)

	e.log.mu.Lock()
	defer e.log.mu.Unlock()
	if len(e.log.events) != 3 {
		t.Fatalf("events = %v", util.Stringify(e.log.events))
	}
	plain := arr(e.log.events[0])[1].(*util.Obj)
	want := `["internal/upstream_protocol.go","internal/upstream_protocol_test.go"]`
	if util.Stringify(plain.Get("changedFiles")) != want || plain.Get("tabId") != "tab_1" {
		t.Fatalf("plain follow-up = %v", util.Stringify(plain))
	}
	withReport := arr(e.log.events[1])[1].(*util.Obj)
	rep, _ := withReport.Get("report").(*util.Obj)
	files := util.Stringify(withReport.Get("changedFiles"))
	if rep == nil || util.Stringify(rep.Get("changedFiles")) != files ||
		files != `["README.md","internal/upstream_protocol.go","internal/upstream_protocol_test.go"]` {
		t.Fatalf("report follow-up = %v", util.Stringify(withReport))
	}
	// 失败 / 被停下的一轮：已经改了的同样带上
	failed := arr(e.log.events[2])[1].(*util.Obj)
	if failed.Get("status") != "error" || util.Stringify(failed.Get("changedFiles")) != want {
		t.Fatalf("failed follow-up = %v", util.Stringify(failed))
	}
}

func TestNomiTaskOf(t *testing.T) {
	tabs := util.NewObj("tabs", []any{
		util.NewObj("id", "a", "delegation", util.NewObj("by", "nomi", "taskId", "t1")),
		util.NewObj("id", "b", "delegation", util.NewObj("by", "user", "taskId", "t2")),
		util.NewObj("id", "c"),
	})
	if NomiTaskOf(tabs, "a") != "t1" || NomiTaskOf(tabs, "b") != "" || NomiTaskOf(tabs, "c") != "" || NomiTaskOf(tabs, "z") != "" {
		t.Fatal("only Nomi-delegated tabs map to a task")
	}
}

func TestParseDelegateReportSplitsInlineMultiplePaths(t *testing.T) {
	text := `[nomi-report]
做了什么：同步了多语言与词典
改动的文件：
packages/i18n/src/locales/zh/ui/models.json packages/i18n/src/locales/en/ui/models.json
apps/desktop-go/internal/core/i18n/locales/zh/ui/models.json (+1 -1), CHANGELOG.md
- 无关说明：这行有中文冒号不按空格拆
[/nomi-report]`
	r := ParseDelegateReport(text)
	if r == nil {
		t.Fatal("expected parsed report")
	}
	want := `["packages/i18n/src/locales/zh/ui/models.json","packages/i18n/src/locales/en/ui/models.json","apps/desktop-go/internal/core/i18n/locales/zh/ui/models.json","CHANGELOG.md","无关说明：这行有中文冒号不按空格拆"]`
	if got := util.Stringify(r.Get("changedFiles")); got != want {
		t.Fatalf("changedFiles = %s, want %s", got, want)
	}
}
