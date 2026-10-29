package main

import (
	"errors"
	"path/filepath"
	"strings"
	"sync/atomic"

	aiproviders "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/accounts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// wireGatewayRequests = createCore 的 new GatewayRequestLog({ root, logger, traceOn, importLegacy })
// 旧「最近请求」requests.json 导入模型质量账本一次后删除；追踪目录跟随诊断日志开关
func wireGatewayRequests(userData string, sp *shellProcs) *usage.GatewayRequestLog {
	return usage.NewGatewayRequestLog(usage.GatewayRequestLogDeps{
		Root:         filepath.Join(userData, "gateway"),
		Logger:       qualityLogger{deps.StdLogger{Prefix: "[gateway-requests]"}},
		TraceOn:      func() bool { return sp.Diagnostics != nil && sp.Diagnostics.BodyTrace() },
		ImportLegacy: func(records []*util.Obj) error { return sp.Quality.ImportLegacy(records) },
	})
}

// usageRef：UsageService（createCore new UsageService）；quality / gateway / agents / accounts 的闭包晚绑定读取
var usageRef atomic.Pointer[usage.UsageService]

// accountsRef：AccountService（wireHarness 里构造）；usage 的 grokAccountKey / officialAccount 晚绑定读取
var accountsRef atomic.Pointer[accounts.AccountService]

// usageEnabled = quality 的 enabled: () => usage.getSettings().enabled ?? true
func usageEnabled() bool {
	if s := usageRef.Load(); s != nil {
		return s.Enabled()
	}
	return true
}

// usageCost = quality 的 cost: (model, tokens) => usage.costOf(model, tokens)
func usageCost(model string, tokens *util.Obj) (float64, bool) {
	if s := usageRef.Load(); s != nil {
		return s.CostOf(model, tokens)
	}
	return 0, false
}

// usageLongContextPrice = gateway 的 longContextPrice: (model) => usage.longContextPrice(model)
func usageLongContextPrice(model string) *util.Obj {
	if s := usageRef.Load(); s != nil {
		return s.LongContextPrice(model)
	}
	return nil
}

// usageForgetAccountQuota = accounts.onDefaultChanged 里的 usage.forgetAccountQuota(kind)（持锁调用）
func usageForgetAccountQuota(kind string) {
	if s := usageRef.Load(); s != nil {
		s.ForgetAccountQuota(kind)
	}
}

// nomiUsageRecorder = AIRuntimeBoot 的 ProviderStore onCall → usage.record({ source: 'nomi', via: 'chat', ... })。
// onCall 在调用方 goroutine 上触发；排进串行队列，由单个 goroutine 按序持锁记账（不在调用方持锁时重入 GIL）。
func nomiUsageRecorder() func(any) {
	q := make(chan *util.Obj, 1024)
	go func() {
		for e := range q {
			jsrt.Run(func() { recordNomiCall(e) })
		}
	}()
	return func(v any) {
		if e, ok := v.(*util.Obj); ok {
			q <- e
		}
	}
}

func recordNomiCall(e *util.Obj) {
	s := usageRef.Load()
	if s == nil {
		return
	}
	str := func(k string) string { x, _ := e.Get(k).(string); return x }
	num := func(k string) float64 { x, _ := e.Get(k).(float64); return x }
	at := num("at")
	provider, model := splitGatewayUsage(str("providerId"), str("model"))
	in := usage.UsageInput{Ts: at, Source: "nomi", Via: "chat", Provider: provider, Model: model,
		PromptTokens: num("inputTokens"), OutputTokens: num("outputTokens"), Est: e.Get("estimated") == true}
	if d, ok := e.Get("durationMs").(float64); ok {
		in.Dur = &d
	}
	if x, ok := e.Get("cacheReadTokens").(float64); ok {
		in.CacheRead = &x
	}
	if x, ok := e.Get("cacheWriteTokens").(float64); ok {
		in.CacheWrite = &x
	}
	if rid := str("reqId"); rid != "" {
		k := "nomi:" + rid + ":" + util.FormatNumber(at)
		in.Key = &k
	}
	s.Record(in)
}

// splitGatewayUsage = ai/gatewayUsage.ts
func splitGatewayUsage(providerID, model string) (string, string) {
	i := strings.Index(model, "/")
	if providerID != aiproviders.GatewayProviderID || i <= 0 {
		return providerID, model
	}
	return model[:i], model[i+1:]
}

// wireUsage = createCore 的 new UsageService({...}) + usage.start()；网关 init 之后 autoSync。返回 stop。
func wireUsage(router *contract.Router, userData string, desktopSvc *desktop.Service, gw *gwstore.Service) func() {
	onData, needsFull := gw.ModelsDataHooks()
	logger := qualityLogger{deps.StdLogger{Prefix: "[usage]"}}
	var s *usage.UsageService
	jsrt.Run(func() {
		s = usage.NewUsageService(usage.ServiceDeps{
			Root:    filepath.Join(userData, "usage"),
			Logger:  logger,
			Publish: func(ev string, p any) { router.Emit(ev, p) },
			ProviderName: func(id string) (string, bool) {
				for _, x := range gw.ListOpenAiCompatible() {
					if p, ok := x.(*util.Obj); ok && p.Get("id") == id {
						n, ok := p.Get("name").(string)
						return n, ok
					}
				}
				return "", false
			},
			GrokAccountKey: func() *string {
				a := accountsRef.Load()
				if a == nil {
					return nil
				}
				k, err := a.IdentityKey("grok", nil)
				if err != nil {
					panic(jsrt.JSThrow{Name: "Error", Message: err.Error()})
				}
				if v, ok := k.(string); ok {
					return &v
				}
				return nil
			},
			OnModelsData:        onData,
			NeedsFullModelsData: needsFull,
			OfficialAccount: func(kind string, prepare bool) (*usage.OfficialAccount, error) {
				a := accountsRef.Load()
				if a == nil {
					return nil, errors.New("accounts not ready")
				}
				if !prepare {
					d, err := a.DefaultDir(kind)
					if err != nil {
						return nil, err
					}
					out := &usage.OfficialAccount{Args: []string{}}
					if v, ok := d.(string); ok {
						out.Dir = &v
					}
					return out, nil
				}
				l, err := a.OfficialLaunch(kind, nil)
				if err != nil {
					return nil, err
				}
				return &usage.OfficialAccount{Dir: l.Dir, Args: l.Args}, nil
			},
			Alert: func(al usage.UsageAlert) bool {
				if desktopSvc.NotifyPolicy != nil && desktopSvc.NotifyPolicy.Quiet() {
					return false
				}
				desktopSvc.Notify(desktop.DesktopNotice{Kind: "info", Status: "attention", Title: al.Title, Body: al.Text,
					Text: util.UTF16Slice0(al.Text, 140), Bubble: util.NewObj("voice", "none")})
				return true
			},
			WithCliPath: cli.WithCliPath,
			AccountEnv:  accounts.OfficialAccountEnv,
			ZstdDecode:  func(b []byte) (string, error) { return cli.ZstdDecode(b, cli.ZstdMaxOutputBytes) },
		})
		usageRef.Store(s)
		s.Start()
		// 启动时自动同步模型数据（cfg.autoSyncModels 缺省 = 开）
		p := s.AutoSync()
		go func() {
			if _, err := jsrt.Block(p); err != nil {
				logger.Warn("models data auto sync failed", err.Error())
			}
		}()
	})
	usage.Install(router, usageRef.Load)
	return func() { jsrt.Run(func() { s.Stop() }) }
}

// usageOf / taskCost = createCore 的 AgentProgressService deps
func agentsUsageOf(source, session string) *util.Obj {
	s := usageRef.Load()
	if s == nil {
		return nil
	}
	if u := s.SessionUsage(source, session); u != nil {
		return u.ToObj()
	}
	return nil
}

func agentsTaskCost(q agents.CostQuery) *jsrt.Promise[string] {
	return jsrt.Async(func() (string, error) {
		s := usageRef.Load()
		if s == nil {
			return "", nil
		}
		// 日志有延迟：先追平一次再算
		_, _ = jsrt.Await(s.Scan())
		return s.TaskCostLine(usage.CostQuery{Source: q.Source, Session: q.Session, Since: q.Since}), nil
	})
}
