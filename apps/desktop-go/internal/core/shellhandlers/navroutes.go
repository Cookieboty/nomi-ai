package shellhandlers

// ELECTRON_WINDOW_ROUTES（packages/host-electron/src/host/electronPorts.ts）+ WindowManager.openProviderPanel：
// 打开对话窗口后向 chat 面发布面板导航事件（{ surface: 'chat' }）。

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"

// WindowRoutes = ELECTRON_WINDOW_ROUTES
var WindowRoutes = map[string]string{
	"providers": "providers.openPanel",
	"desktop":   "nav.desktopPanelRequested",
	"schedule":  "nav.scheduleRequested",
	"voice":     "nav.voiceSettingsRequested",
}

// OpenProviderPanel = openProviderPanel(event = 'providers.openPanel')
func OpenProviderPanel(r *contract.Router, openChat func(), event string) {
	if event == "" {
		event = "providers.openPanel"
	}
	if openChat != nil {
		openChat()
	}
	r.EmitTo(event, map[string]any{}, "chat")
}

// OpenRoute = windows.open('chat', { route })：未知 route 只打开窗口
func OpenRoute(r *contract.Router, openChat func(), route string) {
	if ev, ok := WindowRoutes[route]; ok {
		OpenProviderPanel(r, openChat, ev)
		return
	}
	if openChat != nil {
		openChat()
	}
}
