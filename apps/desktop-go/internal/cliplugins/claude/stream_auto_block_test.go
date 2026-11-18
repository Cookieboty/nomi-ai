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

// 即便前置没有收到 system/permission_denied，只要 result/errors、子代理结束事件或 tool_result
// 里出现了 Claude auto 模式分类器不可用的文本，也应准确翻译并标上 code=auto_mode_no_check_in_session。
func TestAutoModeBlockedDiagnosticsWithoutPermissionDeniedEvent(t *testing.T) {
	state := &StreamState{}
	diag := `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use; Auto mode can't check actions in this session, so Claude stopped after a run of responses whose actions were refused. Use another permission mode to continue.`
	rawResult := fmt.Sprintf(`{"type":"result","subtype":"error_during_execution","is_error":true,"errors":[%q],"session_id":"s1"}`, diag)
	evs := ParseLine(rawResult, state)
	var errEvFound bool
	for _, e := range evs {
		if e.Get("type") == "error" {
			errEvFound = true
			if e.Get("code") != "auto_mode_no_check_in_session" {
				t.Fatalf("error event should carry auto_mode_no_check_in_session code: %v", e)
			}
			msg := fmt.Sprint(e.Get("message"))
			if strings.Contains(msg, "error_during_execution") || strings.Contains(msg, "ede_diagnostic") {
				t.Fatalf("error message should be translated cleanly, got: %q", msg)
			}
		}
	}
	if !errEvFound {
		t.Fatalf("expected error event from result: %v", evs)
	}

	// 子代理 task_notification 里的同类文本也应识别并标记
	subNotif := fmt.Sprintf(`{"type":"system","subtype":"task_notification","task_id":"agent_1","status":"failed","summary":%q}`, diag)
	evs = ParseLine(subNotif, &StreamState{})
	if len(evs) != 1 || evs[0].Get("type") != "agent" || evs[0].Get("code") != "auto_mode_no_check_in_session" {
		t.Fatalf("subagent failure should carry auto_mode_no_check_in_session code: %v", evs)
	}

	// tool_result 错误文本命中也应标记
	toolErr := fmt.Sprintf(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":true,"content":%q}]}}`, diag)
	evs = ParseLine(toolErr, &StreamState{})
	if len(evs) != 1 || evs[0].Get("type") != "tool" || evs[0].Get("code") != "auto_mode_no_check_in_session" {
		t.Fatalf("tool_result error should carry auto_mode_no_check_in_session code: %v", evs)
	}
}
