package harness

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 第一轮出错结束（如供应商 API 400）也要记下会话 id：
// 下一轮（沙箱授权后的「请继续」会先重开进程）带 --resume 接上，而不是开一个空的新会话。
func TestClaudeResumesSessionAfterFailedFirstTurn(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	t.Setenv("NOMI_MOCK_FAIL", "1")
	tab := jsrt.Call(func() *util.Obj { return o.CreateTab(util.NewObj("backend", "claude")) })
	id := str(tab, "id")

	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] { return o.SendTab(id, "do the task", nil, false) })
	_, _ = jsrt.Block(p) // 这一轮按预期失败
	if got := jsrt.Call(func() string { return str(o.tab(id), "status") }); got != "error" {
		t.Fatalf("status=%q want error", got)
	}
	if got := jsrt.Call(func() string { return str(o.tab(id), "cliSessionId") }); got != "mock-claude-session-1" {
		t.Fatalf("cliSessionId=%q after a failed first turn, want mock-claude-session-1", got)
	}

	// 和沙箱授权一样重开进程；新进程自己的会话 id 不同，只有带了 --resume 才会回到原会话
	jsrt.Run(func() { o.recycleTab(id) })
	t.Setenv("NOMI_MOCK_FAIL", "0")
	t.Setenv("NOMI_MOCK_SESSION", "mock-claude-session-new")
	awaitSend(t, o, id, "please continue")
	msgs := jsrt.Call(func() []*util.Obj { return o.TabMessages(id) })
	last := msgs[len(msgs)-1]
	if text := str(last, "content"); !strings.Contains(text, "已续接会话 mock-claude-session-1") {
		t.Fatalf("second turn did not resume the original session: %q", text)
	}
}

// Codex 同理：线程 id 在 app-server 起来时就有，第一轮失败也要记下，下一轮重开进程后 thread/resume 接上
func TestCodexResumesThreadAfterFailedFirstTurn(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	t.Setenv("NOMI_MOCK_CODEX_FAIL", "1")
	tab := jsrt.Call(func() *util.Obj { return o.CreateTab(util.NewObj("backend", "codex")) })
	id := str(tab, "id")

	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] { return o.SendTab(id, "do the task", nil, false) })
	_, _ = jsrt.Block(p)
	if got := jsrt.Call(func() string { return str(o.tab(id), "cliSessionId") }); got != "mock-codex-thread-1" {
		t.Fatalf("cliSessionId=%q after a failed first turn, want mock-codex-thread-1", got)
	}

	jsrt.Run(func() { o.recycleTab(id) })
	t.Setenv("NOMI_MOCK_CODEX_FAIL", "0")
	t.Setenv("NOMI_MOCK_SESSION", "mock-codex-thread-new")
	awaitSend(t, o, id, "please continue")
	msgs := jsrt.Call(func() []*util.Obj { return o.TabMessages(id) })
	if text := str(msgs[len(msgs)-1], "content"); !strings.Contains(text, "已续接会话 mock-codex-thread-1") {
		t.Fatalf("second turn did not resume the original thread: %q", text)
	}
}

// Gemini（ACP）同理：session/new 拿到的会话 id 在第一轮失败后也要留下，下一轮重开进程用 session/load 接上
func TestGeminiKeepsSessionAfterFailedFirstTurn(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	withThirdPartyGateway(o, "gemini")
	t.Setenv("NOMI_MOCK_GEMINI_FAIL", "1")
	tab := jsrt.Call(func() *util.Obj { return o.CreateTab(util.NewObj("backend", "gemini")) })
	id := str(tab, "id")

	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] { return o.SendTab(id, "do the task", nil, false) })
	_, _ = jsrt.Block(p)
	first := jsrt.Call(func() string { return str(o.tab(id), "cliSessionId") })
	if !strings.HasPrefix(first, "gem-") {
		t.Fatalf("cliSessionId=%q after a failed first turn, want the gem-… session", first)
	}

	jsrt.Run(func() { o.recycleTab(id) })
	t.Setenv("NOMI_MOCK_GEMINI_FAIL", "0")
	awaitSend(t, o, id, "please continue")
	if got := jsrt.Call(func() string { return str(o.tab(id), "cliSessionId") }); got != first {
		t.Fatalf("second turn opened a new session %q instead of loading %q", got, first)
	}
}
