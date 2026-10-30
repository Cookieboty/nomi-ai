package knowledgehandlers

import (
	"context"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/memory"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

// asLocalDesktop：真实 DesktopAdapter 自带 say / setLocalOnly；测试用的 Noop 走 localDesktop 兜底
func asLocalDesktop(d deps.Desktop) local.LocalDesktop {
	if ld, ok := d.(local.LocalDesktop); ok {
		return ld
	}
	return localDesktop{Desktop: d}
}

// localDesktop：测试 / 无桌面服务时的兜底适配
type localDesktop struct {
	deps.Desktop
	Say_ func(string)
}

func (d localDesktop) Say(t string) {
	if d.Say_ != nil {
		d.Say_(t)
	}
}
func (d localDesktop) LocalOnly() bool { return d.Broker().LocalOnly() }
func (d localDesktop) SetLocalOnly(on bool) {
	if b, ok := d.Broker().(*deps.FakeBroker); ok {
		b.Local = on
	}
}

type WireDeps struct {
	UserData string
	Router   *contract.Router
	T        i18n.Translate
	Desktop  deps.Desktop // main.go 传 DesktopAdapter{desktopSvc}；nil → NoopDesktop（仅测试）
	Ports    deps.Ports   // nil → NoopPorts（仅测试）
	Complete deps.CompleteFunc
	OpenChat func()
	Gateway  func() local.GatewayLike
	Secrets  security.SecretBox
	// 知识库的云端供应商（向量、云端同意）：aiRuntime.listProviders / providerCredentials、desktop.providerFor('chat')
	Providers    func() []knowledge.Provider
	Credentials  func(id string) *knowledge.Credentials
	ChatProvider func() *knowledge.ChatProvider
	// 记忆同步到 AI 客户端（client.memory）；扩展的 MCP 工具确认（desktop.broker）
	MemoryFacade func() memory.Facade
	Confirm      extensions.ConfirmBroker
}

type Bundle struct {
	KB    *knowledge.Service
	Mem   *memory.Service
	Sched *schedule.Service
	Local *local.Service
	Hub   *local.Hub
	Ext   *extensions.Service
	N     int
}

// Wire：对应 createCore.ts 里批次 8 的服务装配；返回后调用 Start 开启后台任务。
func Wire(d WireDeps) *Bundle {
	if d.Desktop == nil {
		d.Desktop = &deps.NoopDesktop{}
	}
	if d.Ports == nil {
		d.Ports = &deps.NoopPorts{}
	}
	if d.Complete == nil {
		d.Complete = deps.UnavailableComplete
	}
	if d.T == nil {
		d.T = i18n.Identity
	}
	ud := func(p ...string) string { return filepath.Join(append([]string{d.UserData}, p...)...) }
	ev := deps.EventsFunc(d.Router.Emit)
	extensions.SetTranslator(d.T)
	local.SetTranslator(d.T)
	b := &Bundle{}
	b.KB = knowledge.New(knowledge.Deps{Root: ud("knowledge"), Logger: deps.StdLogger{Prefix: "[kb]"}, Desktop: d.Desktop, Complete: d.Complete, Ports: d.Ports, Events: ev, T: d.T,
		ListProviders: d.Providers, Credentials: d.Credentials, ChatProvider: d.ChatProvider})
	b.Mem = memory.New(memory.Deps{Root: ud("memory"), Logger: deps.StdLogger{Prefix: "[mem]"}, Desktop: d.Desktop, Complete: d.Complete, Ports: d.Ports, Events: ev, T: d.T,
		Facade: d.MemoryFacade,
		Embed: func(ctx context.Context, texts []string) ([][]float32, error) {
			return b.KB.EmbedTexts(ctx, texts), nil
		}})
	b.Sched = schedule.New(schedule.Deps{Root: ud("schedule"), Logger: deps.StdLogger{Prefix: "[sched]"}, Desktop: d.Desktop, Complete: d.Complete, Ports: d.Ports, Events: ev, T: d.T, OpenChat: d.OpenChat,
		Memory: func(ctx context.Context, q string) (string, error) { return b.Mem.Context(ctx, q).Text, nil }})
	b.Ext = extensions.New(extensions.Deps{Root: ud("extensions"), SkillsRoot: ud("skills"), Logger: deps.StdLogger{Prefix: "[ext]"}, Desktop: d.Desktop, Ports: d.Ports, Events: ev, Secrets: d.Secrets, Confirm: d.Confirm})
	b.Hub = local.NewHub(local.HubDeps{Root: ud("local"), UserData: d.UserData, Desktop: d.Desktop, Ports: d.Ports, Events: ev})
	b.Local = local.New(local.Deps{Root: ud("local"), Desktop: asLocalDesktop(d.Desktop), Gateway: d.Gateway, Events: ev})
	b.N = Install(d.Router, Services{
		KB: func() *knowledge.Service { return b.KB }, Mem: func() *memory.Service { return b.Mem },
		Sched: func() *schedule.Service { return b.Sched }, Local: func() *local.Service { return b.Local },
		Hub: func() *local.Hub { return b.Hub }, Ext: func() *extensions.Service { return b.Ext },
	})
	return b
}

func (b *Bundle) Start() {
	b.KB.Start()
	b.Mem.Start()
	b.Sched.Start()
	b.Ext.Start()
	go b.Local.AutoStart()
}

func (b *Bundle) Stop() {
	b.Sched.Stop()
	b.Mem.Flush()
	b.KB.Dispose()
	b.Local.Stop()
}
