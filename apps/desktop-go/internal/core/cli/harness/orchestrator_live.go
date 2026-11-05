package harness

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"

// 各后端长驻会话的分工：
//   orchestrator_claude.go    Claude Code
//   orchestrator_acp.go       Gemini / Grok / 外部插件（ACP）
//   orchestrator_codex.go     Codex
//   orchestrator_dsh_grok.go  dsh / grok / spawnCollect
// sendTab / cancelTab / dispose / 回收只经下列方法签名调用；
// 所有 run* 返回 *jsrt.Promise[*util.Obj]（HarnessSendResult），rejection = reject/throw。

// liveState：各后端长驻会话表（Map<tabId, …>，插入序见 *Order）。
type liveState struct {
	claude map[string]*claudeLiveSession
	acp    map[string]*acpLiveSession
	codex  map[string]*codexLiveSession
	// 插入序（[...map.keys()] 用）
	claudeOrder, acpOrder, codexOrder []string
	// claudeStarting = claudeStarting（第三方标签登记绑定后才拉起的进程）
	claudeStarting map[string]*jsrt.Promise[*claudeLiveSession]
	// codexAppUnavailable / grokAcpUnavailable：app-server / ACP 不可用，退回每轮一个进程
	codexAppUnavailable, grokAcpUnavailable bool
}

func (l *liveState) init() {
	l.claude = map[string]*claudeLiveSession{}
	l.acp = map[string]*acpLiveSession{}
	l.codex = map[string]*codexLiveSession{}
	l.claudeStarting = map[string]*jsrt.Promise[*claudeLiveSession]{}
}

func delOrder(s []string, id string) []string {
	for i, x := range s {
		if x == id {
			return append(s[:i:i], s[i+1:]...)
		}
	}
	return s
}

// setClaude / delClaude 等维持 Map 插入序。
func (l *liveState) setClaude(id string, v *claudeLiveSession) {
	if _, ok := l.claude[id]; !ok {
		l.claudeOrder = append(l.claudeOrder, id)
	}
	l.claude[id] = v
}
func (l *liveState) delClaude(id string) {
	delete(l.claude, id)
	l.claudeOrder = delOrder(l.claudeOrder, id)
}
func (l *liveState) setAcp(id string, v *acpLiveSession) {
	if _, ok := l.acp[id]; !ok {
		l.acpOrder = append(l.acpOrder, id)
	}
	l.acp[id] = v
}
func (l *liveState) delAcp(id string) { delete(l.acp, id); l.acpOrder = delOrder(l.acpOrder, id) }
func (l *liveState) setCodex(id string, v *codexLiveSession) {
	if _, ok := l.codex[id]; !ok {
		l.codexOrder = append(l.codexOrder, id)
	}
	l.codex[id] = v
}
func (l *liveState) delCodex(id string) {
	delete(l.codex, id)
	l.codexOrder = delOrder(l.codexOrder, id)
}
