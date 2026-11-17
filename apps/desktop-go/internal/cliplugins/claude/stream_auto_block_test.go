package claude

import (
	"fmt"
	"strings"
	"testing"
)

// auto 模式在第三方网关下分类器不可用：Claude 先发 informational（tag=auto_mode_no_server_check），
// 然后每个要检查的动作都发 permission_denied（decision_reason_code=auto_mode_no_check_in_session）。
// 这些事件以前全被 ParseLine 丢掉，用户只看到「跑着跑着失败了」。
func TestParseAutoModeBlocked(t *testing.T) {
	state := &StreamState{}
	info := `{"type":"system","subtype":"informational","tag":"auto_mode_no_server_check","level":"warn","content":"Auto mode can't check actions in this session."}`
	evs := ParseLine(info, state)
	if len(evs) != 1 || evs[0].Get("type") != "notice" || evs[0].Get("tag") != "auto_mode_no_server_check" {
		t.Fatalf("informational = %v", evs)
	}
	if state.NoticeCode != "auto_mode_no_server_check" {
		t.Fatalf("notice code = %q", state.NoticeCode)
	}
	denied := `{"type":"system","subtype":"permission_denied","tool_name":"Task","decision_reason_code":"auto_mode_no_check_in_session","decision_reason":"Classifier unavailable"}`
	evs = ParseLine(denied, state)
	if len(evs) != 1 || evs[0].Get("type") != "permission-denied" || evs[0].Get("tool") != "Task" ||
		evs[0].Get("code") != "auto_mode_no_check_in_session" || evs[0].Get("reason") != "Classifier unavailable" {
		t.Fatalf("permission_denied = %v", evs)
	}
	// 同一个工具反复被拒只记一次，换一个工具追加
	ParseLine(denied, state)
	ParseLine(strings.Replace(denied, `"Task"`, `"Bash"`, 1), state)
	if got := strings.Join(state.DeniedTools, ","); got != "Task,Bash" {
		t.Fatalf("denied tools = %q", got)
	}
}

// 这一轮最后要给一句人话（点名被拒的工具 + 让用户换权限模式），而不是光秃秃的 error_during_execution。
func TestAutoModeBlockedResultExplained(t *testing.T) {
	state := &StreamState{}
	for _, tool := range []string{"Task", "Bash"} {
		ParseLine(`{"type":"system","subtype":"permission_denied","tool_name":"`+tool+`","decision_reason_code":"auto_mode_no_check_in_session"}`, state)
	}
	evs := ParseLine(`{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":1,"num_turns":1,"result":""}`, state)
	var msg string
	for _, e := range evs {
		if e.Get("type") == "error" {
			msg = fmt.Sprint(e.Get("message"))
		}
	}
	if msg == "" {
		t.Fatalf("no error event: %v", evs)
	}
	if !strings.Contains(msg, "Task, Bash") {
		t.Fatalf("error message should name the blocked tools: %q", msg)
	}
	if strings.Contains(msg, "error_during_execution") || strings.Contains(msg, "tool_use") {
		t.Fatalf("error message should explain, not echo the raw result: %q", msg)
	}
	if state.DeniedCode != "" || len(state.DeniedTools) != 0 {
		t.Fatalf("state should be reset after explaining: %q %v", state.DeniedCode, state.DeniedTools)
	}
}
