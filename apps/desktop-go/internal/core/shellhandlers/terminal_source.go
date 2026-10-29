package shellhandlers

// gatewayTerminalSource（packages/core/src/gateway/TerminalCommands.ts）+ createCore.ts:728 的接线。

import (
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/terminal"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// GatewayTerminalSource = gatewayTerminalSource(g)
func GatewayTerminalSource(g *gwstore.Service) func() *terminal.Source {
	return func() *terminal.Source {
		st := g.Status()
		snap := g.Store.Snapshot()
		var port float64
		if st.State == "running" {
			port = float64(st.Port)
		} else {
			port, _ = snap.Get("port").(float64)
		}
		if port == 0 {
			return nil
		}
		clients := map[string]*terminal.Client{}
		sc, _ := snap.Get("clients").(*u.Obj)
		for _, kind := range terminal.Kinds {
			var tok *string
			if t, ok := g.Store.ClientToken(kind); ok {
				tok = &t
			}
			models := u.NewObj()
			if sc != nil {
				if c, _ := sc.Get(kind).(*u.Obj); c != nil {
					if m, _ := c.Get("models").(*u.Obj); m != nil {
						models = m
					}
				}
			}
			clients[kind] = &terminal.Client{Token: tok, Models: models}
		}
		var catalog []string
		for _, m := range g.CliModels() {
			r, _ := m.Get("ref").(string)
			catalog = append(catalog, r)
		}
		return &terminal.Source{
			URL:     "http://127.0.0.1:" + i18n.JSNumber(port),
			Clients: clients,
			MetaOf:  func(ref string) *agents.ModelMeta { return g.AgentMeta(ref, nil) },
			Catalog: catalog,
		}
	}
}

// NewGatewayTerminal：new TerminalCommands({root: userData/gateway, source, logger, onEnabled: ensureStarted})
// + terminal.refresh() + gateway.onChange(() => terminal.refresh())
func NewGatewayTerminal(userData string, g *gwstore.Service, logger terminal.Logger) *terminal.Commands {
	if g == nil {
		return nil
	}
	t := terminal.New(terminal.Deps{
		Root:      filepath.Join(userData, "gateway"),
		Source:    GatewayTerminalSource(g),
		Logger:    logger,
		OnEnabled: g.EnsureStarted,
	})
	t.Refresh()
	// 异步：onChange 可能在 EnsureStarted 内同步触发，而 Refresh 持有 Commands.mu（Node 单线程可重入，Go 不可）
	g.OnChange(func() { go t.Refresh() })
	return t
}
