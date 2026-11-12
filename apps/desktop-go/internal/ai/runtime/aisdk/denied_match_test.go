package aisdk

// 「有一步被你拒绝了，我先停在这里」会一直冒出来的原因：
// deniedTool 以前是裸子串匹配，读一段源码 / i18n 文案 / 委派的错误码清单、
// 或查一个被拒绝过的委派状态时，只要输出里出现 user_denied 这个词就算「用户拒绝」。

import "testing"

func TestDeniedToolOnlyTrustsStructuredDenial(t *testing.T) {
	denied := []string{
		"user_denied",
		"mode_blocked",
		"user_denied: 用户拒绝了这个操作，不要重试同一个调用",
		`{"ok":false,"error":{"code":"user_denied","message":"no"}}`,
		`{"ok":false,"error":{"code":"mode_blocked"}}`,
		`{"ok":false,"code":"user_denied"}`,
	}
	for _, s := range denied {
		if !deniedTool(s) {
			t.Fatalf("should count as denied: %s", s)
		}
	}

	// 只是「提到了这个词」的内容：不是拒绝
	notDenied := []string{
		"",
		// 源码 / 文档
		`func toolErrorCodeDenied(err any) bool { return deniedTool(c.ToolErrorCode()) } // user_denied`,
		`"cwd_not_granted", "isolation_failed", "mode_blocked", "user_denied", "timeout_denied"`,
		// 读到 i18n 文案
		`{"electron.common.auto-continue-stopped-denied": "（有一步被你拒绝了…）"}`,
		// 查询一个失败过的委派：ok:true，历史错误码在 data 里
		`{"ok":true,"data":{"status":"failed","error":{"code":"user_denied"}}}`,
		// 成功的工具输出里带这个词
		`{"ok":true,"files":["deniedTool_test.go"]}`,
		// 普通文本
		`deniedTool 里 user_denied 是错误码`,
	}
	for _, s := range notDenied {
		if deniedTool(s) {
			t.Fatalf("should NOT count as denied: %s", s)
		}
	}
}
