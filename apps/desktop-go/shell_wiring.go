package main

import (
	"context"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/diagnostics"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// shellProcs：packages/contract/src/app/shell.ts 中 batch 2–5 之外的过程（diagnostics / appIcon / updates / quality / usage / gateway）
type shellProcs struct {
	Diagnostics *diagnostics.Service
}

func installShellProcs(router *contract.Router, userData string, sh *shell.Shell, gw *gwstore.Service) *shellProcs {
	hp := hostPorts{sh: sh}
	sp := &shellProcs{}
	sp.Diagnostics = diagnostics.New(diagnostics.Deps{
		UserData: userData,
		Logger:   deps.StdLogger{Prefix: "[diagnostics]"},
		Ports: diagnostics.Ports{
			IsPackaged: hostports.IsPackaged,
			Version:    func() string { return hostports.AppVersion },
			SaveFile: func(title, def string, fs []diagnostics.FileFilter) (string, error) {
				ff := make([]deps.FileFilter, 0, len(fs))
				for _, f := range fs {
					ff = append(ff, deps.FileFilter{Name: f.Name, Extensions: f.Extensions})
				}
				return hp.SaveFile(context.Background(), title, def, ff)
			},
			OpenPath: hp.OpenPath,
		},
		TraceDir:      filepath.Join(userData, "gateway", "trace"),
		LegacyEnabled: func() bool { return diagnostics.ReadLegacyGatewayTrace(filepath.Join(userData, "gateway")) },
		OnChange: func(bool) {
			if gw != nil {
				gw.Refresh()
			}
		},
	})
	shellhandlers.InstallDiagnostics(router, func() *diagnostics.Service { return sp.Diagnostics })
	return sp
}
