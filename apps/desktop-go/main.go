// Nomi Go + Wails v3 架构 POC（docs/design/arch-go-wails.md）。
//
//	NOMI_LLM_BASE_URL / NOMI_LLM_API_KEY / NOMI_LLM_MODEL：OpenAI 兼容接口；没有 key 时起本地 mock。
//	NOMI_POC_CTL=127.0.0.1:PORT：测量用的控制口（/ctl?op=show-chat|close-chat|hide-mascot|show-mascot|renderer&v=svg|rive|quit）。
//	NOMI_USER_DATA / NOMI_APP_DATA：覆盖 userData / appData 根（测试与迁移用）。
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/character"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledgehandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mascothandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/wailsshell"
)

//go:embed all:frontend/dist
var dist embed.FS

func main() {
	cfg := core.LLMConfig{BaseURL: os.Getenv("NOMI_LLM_BASE_URL"), APIKey: os.Getenv("NOMI_LLM_API_KEY"), Model: os.Getenv("NOMI_LLM_MODEL")}
	if cfg.APIKey == "" {
		base, err := mockllm.Start()
		if err != nil {
			log.Fatal(err)
		}
		cfg = core.LLMConfig{BaseURL: base, APIKey: "mock", Model: "mock"}
		log.Printf("[poc] no API key, using mock LLM at %s", base)
	}
	if cfg.Model == "" {
		cfg.Model = "gpt-4o-mini"
	}

	paths := hostports.Paths{UserDataDir: os.Getenv("NOMI_USER_DATA")}
	userData := paths.UserData()
	if err := os.MkdirAll(userData, 0o700); err != nil {
		log.Fatal(err)
	}
	if res, err := migrate.Run(userData, security.NewSecretBox("migrate"), security.NewElectronSafeStorage()); err != nil {
		log.Printf("[migrate] warn: %v", err)
	} else if res.Migrated {
		log.Printf("[migrate] copied %d files from %s (secrets=%d chatKeys=%d)", res.FilesCopied, res.From, res.SecretsMigrated, res.ChatKeysExtracted)
	}

	router := contract.NewRouter()
	core.New(cfg).Register(router)

	var sh shell.Shell
	bundle := shellhandlers.Install(shellhandlers.Deps{
		UserData: userData,
		Router:   router,
		OpenChat: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
		SystemLangs: systemLangs(),
		IsDark:      func() bool { return false },
	})
	isl := island.New(filepath.Join(userData, "island.json"), mascothandlers.Platform())
	isl.Notify = func(kind, title, body string, durationMs int, force bool) bool {
		if sh == nil {
			return false
		}
		sh.Show(shell.Island)
		return true
	}
	mascotCtl := mascothandlers.Install(mascothandlers.Deps{
		Router:    router,
		Config:    bundle.Config,
		Settings:  bundle.Settings,
		Character: character.NewService(userData, os.Getenv("NOMI_RESOURCES"), builtinPackDir()),
		Island:    isl,
		Geometry: func() shell.Geometry {
			g, _ := sh.(shell.Geometry)
			return g
		},
		Quit:     func() { sh.Quit() },
		OpenChat: func() { sh.Show(shell.Chat) },
		AppName:  "Nomi",
	})
	// 批次 6：桌面工具 / 工作区（授权、审计、撤销、回收站、提醒、拖入总结）
	i18n.SetLocale(func() string { return bundle.Locale.Get().Locale })
	home, _ := os.UserHomeDir()
	ports := hostPorts{sh: &sh}
	desktopSvc := desktop.CreateService(userData, desktop.Ports{Home: home, PickDirectory: func(title, button, def string) string {
		dir, _ := ports.PickDir(title, button, def)
		return dir
	}}, router.EmitTo)
	desktopSvc.AttachWindows(&desktop.Windows{Main: func() bool { return sh != nil }})
	desktop.Register(router, desktopSvc)
	desktopSvc.StartReminders()
	// 批次 8：知识库 / 记忆 / 定时 / 本地模型 / 导出 / 扩展。
	// Desktop 用批次 6 的同一个 DesktopService；TODO(batch-4/5): Complete / Gateway 接 AI runtime。
	b8 := knowledgehandlers.Wire(knowledgehandlers.WireDeps{
		UserData: userData,
		Router:   router,
		Secrets:  security.NewSecretBox("extensions"),
		Desktop:  knowledgehandlers.DesktopAdapter{S: desktopSvc},
		T:        i18n.T,
		Ports:    ports,
		OpenChat: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
	})
	b8.Start()
	defer b8.Stop()
	log.Printf("[desktop-go] %d contract procedures stubbed (not implemented yet)", procs.Install(router))

	ws := &contract.WSServer{Router: router, Token: contract.NewToken(), Origins: map[string]bool{
		"wails://localhost": true, "wails://wails": true, "http://wails.localhost": true, "wails://wails.localhost": true,
	}}
	if err := ws.Start(); err != nil {
		log.Fatal(err)
	}

	assets, _ := fs.Sub(dist, "frontend/dist")
	frag := url.Values{"ws": {ws.URL}, "token": {ws.Token}}
	ctl := os.Getenv("NOMI_POC_CTL")
	if ctl != "" {
		frag.Set("ctl", ctl)
	}
	sh = wailsshell.New(wailsshell.Config{Assets: assets, Fragment: frag, MascotSize: mascotCtl.WindowSize})

	if ctl != "" {
		go http.ListenAndServe(ctl, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/mark" {
				log.Printf("[poc] mascot mark %s", r.URL.Query().Get("n"))
				return
			}
			switch r.URL.Query().Get("op") {
			case "show-chat":
				sh.Show(shell.Chat)
			case "close-chat":
				sh.Destroy(shell.Chat)
			case "show-mascot":
				sh.Show(shell.Mascot)
			case "show-island":
				sh.Show(shell.Island)
			case "hide-mascot":
				sh.Destroy(shell.Mascot)
			case "renderer": // 测量用：等同 mascot.setRenderer（写设置 + 广播）
				if v := r.URL.Query().Get("v"); v == "svg" || v == "rive" {
					if err := bundle.Settings.SetMascotRenderer(v); err == nil {
						router.Emit("mascot.rendererChanged", v)
					}
				}
			case "quit":
				sh.Quit()
			}
			w.Write([]byte("ok\n"))
		}))
	}

	sh.Show(shell.Mascot)
	if !sh.TrayAvailable() {
		sh.Show(shell.Chat)
	}
	if err := sh.Run(); err != nil {
		log.Fatal(err)
	}
}

func systemLangs() []string {
	for _, k := range []string{"LANG", "LC_ALL", "LC_MESSAGES"} {
		if v := os.Getenv(k); v != "" {
			return []string{strings.Split(v, ".")[0]}
		}
	}
	return []string{"zh-CN"}
}

// builtinPackDir：NOMI_CHARACTER_PACK，否则从可执行文件 / 工作目录向上找仓库里的 characters/nomi
func builtinPackDir() string {
	if v := os.Getenv("NOMI_CHARACTER_PACK"); v != "" {
		return v
	}
	var starts []string
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, d := range starts {
		for i := 0; i < 6; i++ {
			p := filepath.Join(d, "characters", "nomi")
			if _, err := os.Stat(filepath.Join(p, "manifest.json")); err == nil {
				return p
			}
			d = filepath.Dir(d)
		}
	}
	return ""
}
