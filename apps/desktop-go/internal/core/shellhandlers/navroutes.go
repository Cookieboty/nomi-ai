package shellhandlers

// 面板导航见 internal/core/chatnav（ELECTRON_WINDOW_ROUTES + openProviderPanel + nav.takePending）。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatnav"
)

// WindowRoutes = ELECTRON_WINDOW_ROUTES
var WindowRoutes = chatnav.Routes

// OpenProviderPanel = openProviderPanel(event = 'providers.openPanel')
func OpenProviderPanel(r *contract.Router, openChat func(), event string) {
	chatnav.OpenPanel(r, openChat, event)
}

// OpenRoute = windows.open('chat', { route })
func OpenRoute(r *contract.Router, openChat func(), route string) {
	chatnav.OpenRoute(r, openChat, route)
}
