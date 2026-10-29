// Nomi Go + Wails v3 架构 POC（docs/design/arch-go-wails.md）。
//
//	NOMI_LLM_BASE_URL / NOMI_LLM_API_KEY / NOMI_LLM_MODEL：OpenAI 兼容接口；没有 key 时起本地 mock。
//	NOMI_POC_CTL=127.0.0.1:PORT：测量用的控制口（/ctl?op=show-chat|close-chat|hide-mascot|show-mascot|quit）。
//	NOMI_USER_DATA / NOMI_APP_DATA：覆盖 userData / appData 根（测试与迁移用）。
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core"
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
	shellhandlers.Install(shellhandlers.Deps{
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
	sh = wailsshell.New(wailsshell.Config{Assets: assets, Fragment: frag})

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
