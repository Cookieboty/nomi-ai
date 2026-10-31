package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/appicon"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/diagnostics"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/quality"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/updates"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/wailsshell"
)

// shellProcs：packages/contract/src/app/shell.ts 中 batch 2–5 之外的过程（diagnostics / appIcon / updates / quality / usage / gateway）
type shellProcs struct {
	Diagnostics *diagnostics.Service
	AppIcon     *appicon.Service
	Updates     *updates.Service
	Quality     *quality.Service

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
	// quality.*（QualityService，createCore 1:1）：userData/usage/quality；enabled / cost 来自 UsageService（晚绑定）
	sp.Quality = quality.New(quality.ServiceDeps{
		Dir:     filepath.Join(userData, "usage", "quality"),
		Enabled: usageEnabled,
		Cost:    usageCost,
		Logger:  qualityLogger{deps.StdLogger{Prefix: "[quality]"}},
		LabelOf: gatewayLabelOf(gw),
		Publish: func(ev string, p any) { router.Emit(ev, p) },
		SaveFile: func(title, def string, fs []deps.FileFilter) (string, error) {
			return hp.SaveFile(context.Background(), title, def, fs)
		},
	})
	qualityRef.Store(sp.Quality)
	quality.Install(router, func() *quality.Service { return sp.Quality })
	shellhandlers.InstallDiagnostics(router, func() *diagnostics.Service { return sp.Diagnostics })
	// appIcon.*：图都从 assets 目录读（打包后 resources/assets，开发时 apps/desktop-electron/assets）
	assets := assetsDir()
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
	shellhandlers.InstallUpdates(router, func() *updates.Service { return sp.Updates }, &updates.Notes{
		Version:  func() string { return hostports.AppVersion },
		UserData: userData,
		Log:      deps.StdLogger{Prefix: "[updates]"},
	})
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

// qualityRef：网关 OnUsage（AttachRuntime 早于 installShellProcs）经此找到 QualityService
var qualityRef atomic.Pointer[quality.Service]

// qualityOnUsage = onUsage: (e) => quality.addGateway(e)
func qualityOnUsage(e *u.Obj) {
	if q := qualityRef.Load(); q != nil {
		q.AddGateway(e)
	}
}

type qualityLogger struct{ l deps.StdLogger }

func (q qualityLogger) Info(msg string, data any) { q.l.Info(msg, data) }
func (q qualityLogger) Warn(msg string, data any) { q.l.Warn(msg, data) }

// gatewayLabelOf = createCore 的 labelOf（供应商名 / Key 名或掩码）
func gatewayLabelOf(gw *gwstore.Service) quality.LabelOf {
	providerOf := func(pid string) *u.Obj {
		if gw == nil {
			return nil
		}
		for _, p := range gw.Store.View().Providers() { // 锁外读：已发布的只读快照（#195）
			if o, ok := p.(*u.Obj); ok {
				if id, _ := o.Get("id").(string); id == pid {
					return o
				}
			}
		}
		return nil
	}
	str := func(v any) (string, bool) { s, ok := v.(string); return s, ok }
	return func(dim, key string) (string, bool) {
		if dim == "provider" {
			if p := providerOf(key); p != nil {
				return str(p.Get("name"))
			}
			return "", false
		}
		if dim != "key" {
			return "", false
		}
		parts := strings.Split(key, "\x00")
		pid, kid := parts[0], ""
		if len(parts) > 1 {
			kid = parts[1]
		}
		p := providerOf(pid)
		if p == nil {
			return "", false
		}
		keys, _ := p.Get("keys").([]any)
		for _, k := range keys {
			o, ok := k.(*u.Obj)
			if !ok {
				continue
			}
			if id, _ := o.Get("id").(string); id != kid {
				continue
			}
			if n := o.Get("name"); n != nil && n != u.Undefined {
				return str(n)
			}
			return str(o.Get("masked"))
		}
		return "", false
	}
}
