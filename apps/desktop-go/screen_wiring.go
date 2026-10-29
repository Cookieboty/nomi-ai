package main

import (
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/pendingevents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/screen"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
)

type screenLog struct{ l *services.LoggerService }

func (s screenLog) Warn(m string, x any) { s.l.Warn(m, "error", x) }

// wireScreenAndPending：screen.checkSend（ScreenService，含旧屏幕记忆清理）与
// nav.takePending（pendingEvents 的 nav 组；summary 组由 desktop.takePendingSummary 自己的槽位承担）
func wireScreenAndPending(router *contract.Router, userData string, rootLog *services.LoggerService, d *desktop.Service) {
	svc := screen.New(screen.Deps{
		Root:        filepath.Join(userData, "screen-memory"),
		Logger:      screenLog{rootLog},
		ProviderFor: d.ProviderFor,
		CheckSend:   d.Broker.CheckSend,
	})
	screen.Register(router, func() *screen.Service { return svc })
	pendingevents.Register(router, pendingevents.New(pendingevents.Options{Groups: pendingevents.CoreGroups[:1]}))
}
