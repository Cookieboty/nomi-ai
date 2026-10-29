// Package chatnav 对话窗口的面板导航：ELECTRON_WINDOW_ROUTES + WindowManager.openProviderPanel
// （packages/host-electron）。打开对话窗口后只向 chat 面发布导航事件；没送达时由
// pendingevents（Router.Pending，b7s2）留槽，对话窗口挂载后经 nav.takePending 取走。
package chatnav

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"

// Routes = ELECTRON_WINDOW_ROUTES
var Routes = map[string]string{
	"providers": "providers.openPanel",
	"desktop":   "nav.desktopPanelRequested",
	"schedule":  "nav.scheduleRequested",
	"voice":     "nav.voiceSettingsRequested",
}

// OpenPanel = WindowManager.openProviderPanel(event = 'providers.openPanel')
func OpenPanel(r *contract.Router, openChat func(), event string) {
	if event == "" {
		event = "providers.openPanel"
	}
	if openChat != nil {
		openChat()
	}
	r.EmitTo(event, map[string]any{}, "chat")
}

// OpenRoute = ports.windows.open('chat', { route })：未知 route 只打开窗口
func OpenRoute(r *contract.Router, openChat func(), route string) {
	if ev, ok := Routes[route]; ok {
		OpenPanel(r, openChat, ev)
		return
	}
	if openChat != nil {
		openChat()
	}
}
