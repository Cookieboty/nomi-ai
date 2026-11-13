package main

import (
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// agentsSvc：wireAgents 构造的编程助手监视（Agent 看板读它认出的外部会话）；
// onAgentsChanged：它推 agents.changed 时顺带调用（fleet_wiring.go 设置）。两者都只在 GIL 里读写。
var (
	agentsSvc       *agents.Service
	onAgentsChanged func()
)

// wireAgents：构造 AgentProgressService 并接到编排器（attachHarness）。
// usageOf / taskCost 来自 UsageService（usage_wiring.go）。
func wireAgents(router *contract.Router, userData string, d *desktop.Service) func() {
	o := harnessOrch
	var s *agents.Service
	jsrt.Run(func() {
		s = agents.New(agents.Deps{
			Root: filepath.Join(userData, "agents"), Logger: deps.StdLogger{Prefix: "[agents]"},
			Events: deps.EventsFunc(func(ev string, p any) {
				router.Emit(ev, p)
				if ev == "agents.changed" && onAgentsChanged != nil {
					onAgentsChanged()
				}
			}),
			Notify: func(n agents.Notice) {
				d.Notify(desktop.DesktopNotice{Kind: n.Kind, Title: n.Title, Text: n.Text, Body: n.Body, Status: n.Status,
					Endpoint: n.Endpoint, Session: n.Session, Passive: n.Passive, Bubble: n.Bubble})
			},
			IsQuiet:  func() bool { return d.NotifyPolicy != nil && d.NotifyPolicy.Quiet() },
			UsageOf:  agentsUsageOf,
			TaskCost: agentsTaskCost,
		})
		if o != nil {
			ev := o.Events()
			s.AttachHarness(agents.Harness{
				Tabs: func() []*util.Obj {
					out := []*util.Obj{}
					arr, _ := o.ListTabs().Get("tabs").([]any)
					for _, x := range arr {
						if t, ok := x.(*util.Obj); ok && t.Get("backend") != "external" {
							out = append(out, t)
						}
					}
					return out
				},
				OnTabs: func(fn func()) { ev.On("tabs", func(any) { fn() }) },
				OnFinished: func(fn func(agents.EndpointFinished)) {
					ev.On("tab-finished", func(v any) {
						e, ok := v.(harness.TabFinished)
						if !ok || e.Backend == "external" {
							return
						}
						f := agents.EndpointFinished{TabID: e.TabID, Title: e.Title, Backend: e.Backend, Ok: e.Ok, Text: e.Text, Background: e.Background}
						if e.Error != nil {
							f.Error = *e.Error
						}
						fn(f)
					})
				},
				OnPermission: func(fn func(agents.EndpointPermissionNeeded)) {
					ev.On("permission-needed", func(v any) {
						e := util.AsObj(v)
						if e.Get("backend") == "external" {
							return
						}
						str := func(k string) string { x, _ := e.Get(k).(string); return x }
						fn(agents.EndpointPermissionNeeded{TabID: str("tabId"), Title: str("title"), Backend: str("backend"),
							Summary: str("summary"), Background: e.Get("background") == true})
					})
				},
			})
		}
		if s.Settings().Enabled {
			s.Start()
		}
		agentsSvc = s
	})
	codinghandlers.RegisterAgents(router, func() codinghandlers.Agents { return s })
	return func() { jsrt.Run(func() { s.Stop() }) }
}
