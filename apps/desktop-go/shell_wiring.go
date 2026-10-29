package main

import (
	"context"
	"os"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/appicon"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/diagnostics"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/updates"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/wailsshell"
)

// shellProcs：packages/contract/src/app/shell.ts 中 batch 2–5 之外的过程（diagnostics / appIcon / updates / quality / usage / gateway）
type shellProcs struct {
	Diagnostics *diagnostics.Service
	AppIcon     *appicon.Service
	Updates     *updates.Service

	userData string
	hp       hostPorts
}

func installShellProcs(router *contract.Router, userData string, sh *shell.Shell, gw *gwstore.Service) *shellProcs {
	hp := hostPorts{sh: sh}
	sp := &shellProcs{userData: userData, hp: hp}
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
		TraceDir: filepath.Join(userData, "gateway", "trace"),
		// logger.setLevel(enabled || dev ? DEBUG : INFO)
		SetLevel: func(debug bool) {
			if l, ok := deps.Root.(*services.LoggerService); ok {
				if debug {
					l.SetLevel(services.DEBUG)
				} else {
					l.SetLevel(services.INFO)
				}
			}
		},
		LegacyEnabled: func() bool { return diagnostics.ReadLegacyGatewayTrace(filepath.Join(userData, "gateway")) },
		OnChange: func(bool) {
			if gw != nil {
				gw.Refresh()
			}
		},
	})
	harness.CliTrap = sp.Diagnostics.CliTrace.Tap
	shellhandlers.InstallDiagnostics(router, func() *diagnostics.Service { return sp.Diagnostics })
	// appIcon.*：图都从 assets 目录读（打包后 resources/assets，开发时 packages/host-electron/assets）
	assets := filepath.Dir(filepath.Dir(filepath.Dir(chatBgPresetFile())))
	sp.AppIcon = appicon.New(assets, assets, iconTarget{hp})
	shellhandlers.InstallAppIcon(router, sp.AppIcon)
	// updates.*：electron-updater 换成读 latest-go.json 的 GitHubUpdater（D3 / D-SH-3）
	cache, err := os.UserCacheDir()
	if err != nil {
		cache = os.TempDir()
	}
	sp.Updates = updates.New(deps.StdLogger{Prefix: "[updates]"}, updates.Options{
		Version:  func() string { return hostports.AppVersion },
		Packaged: hostports.IsPackaged(),
		Publish:  router.Emit,
		UserData: userData,
		Updater: &updates.GitHubUpdater{
			Version:  func() string { return hostports.AppVersion },
			CacheDir: filepath.Join(cache, "nomi-updater"),
			Quit: func() {
				if sh != nil && *sh != nil {
					(*sh).Quit()
				}
			},
		},
	})
	shellhandlers.InstallUpdates(router, func() *updates.Service { return sp.Updates })
	return sp
}

// AttachShell：外壳建好之后（= Application 里 app ready 后 initAppIcon）
func (sp *shellProcs) AttachShell() {
	if w := sp.hp.w(); w != nil {
		w.OnWindowCreated(func(iw wailsshell.IconWindow) { sp.AppIcon.ApplyToWindow(iw) })
	}
	sp.AppIcon.Init(filepath.Join(sp.userData, "app-icon.json"))
	sp.Updates.Start()
}

// iconTarget：appicon.Target 的 Wails 实现
type iconTarget struct{ hp hostPorts }

func (t iconTarget) SetDockIcon(p string) {
	if w := t.hp.w(); w != nil {
		w.SetDockIcon(p)
	}
}

func (t iconTarget) SetTrayIcon(p string) {
	if w := t.hp.w(); w != nil {
		w.SetTrayIcon(p)
	}
}

func (t iconTarget) Windows() []appicon.Window {
	w := t.hp.w()
	if w == nil {
		return nil
	}
	var out []appicon.Window
	for _, iw := range w.IconWindows() {
		out = append(out, iw)
	}
	return out
}
