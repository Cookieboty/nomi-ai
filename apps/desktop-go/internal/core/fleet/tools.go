package fleet

// tools.go：给 Nomi 的看板工具：list_agents（看谁在跑、内存压力）、pause_agent / resume_agent（暂停 / 继续纳管的编程助手）。
// 外部的（用户在终端 / IDE 里开的）只读：pause_agent 一律拒绝。

import (
	"context"
	"math"
	"regexp"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	listInputSchema  = `{"type":"object","properties":{},"additionalProperties":false}`
	agentInputSchema = `{"type":"object","properties":{"id":{"type":"string","minLength":1,"description":"list_agents 返回的 agent id（如 tab:xxx）"}},"required":["id"],"additionalProperties":false}`
	// toolListMax：list_agents 最多列多少个（在跑 / 要你处理的在前）
	toolListMax = 30
	// toolSummaryMax：list_agents 里已完成的总结截到多少字
	toolSummaryMax = 120
)

// gateAgents：对话里说到 agent / 内存 / 卡 / 负载 / 暂停继续 / 派出去的事时才提供这组工具（工具集只增不减）
var gateAgents = regexp.MustCompile(`agent|代理|内存|卡顿|好卡|太卡|卡死|很慢|变慢|资源|负载|占用|cpu|memory|ram|暂停|继续跑|恢复|看板|进程|谁在跑|在跑什么|在干什么|编程助手|委派|后台|派出|claude|codex|grok|gemini|pause|resume|load|process|background`)

func agentsRelevant(t tools.Turn) bool { return gateAgents.MatchString(t.ConvoText) }

func schema(s string) *util.Obj {
	v, err := util.ParseString(s)
	if err != nil {
		panic(err)
	}
	return v.(*util.Obj)
}

func toMB(b float64) float64 { return math.Round(b / (1024 * 1024)) }

func round1(x float64) float64 { return math.Round(x*10) / 10 }

// toolAgent：给模型看的一项（紧凑）
func toolAgent(a Agent) map[string]any {
	o := map[string]any{"id": a.ID, "kind": a.Kind, "backend": a.Backend, "origin": a.Origin, "column": a.Column}
	if a.Title != "" {
		o["title"] = a.Title
	}
	if a.Scope == "external" {
		o["readOnly"] = true
	}
	if a.NeedsYou != "" {
		o["needsYou"] = a.NeedsYou
	}
	if a.Failed {
		o["failed"] = true
	}
	if a.Paused != nil {
		o["pausedBy"] = a.Paused.By
	}
	if a.Pausable {
		o["pausable"] = true
	}
	if a.Held {
		o["heldForMemory"] = true
	}
	if a.ParentID != "" {
		o["parentId"] = a.ParentID
	}
	if a.Cwd != "" {
		o["cwd"] = a.Cwd
	}
	if a.Usage != nil {
		o["memoryMB"] = toMB(a.Usage.RSSBytes)
		o["cpuPercent"] = round1(a.Usage.CPUPercent)
	}
	if a.Summary != "" {
		r := []rune(a.Summary)
		if len(r) > toolSummaryMax {
			r = append(r[:toolSummaryMax], '…')
		}
		o["summary"] = string(r)
	}
	return o
}

// ToolView：list_agents 的结果
func ToolView(st State, holding bool) map[string]any {
	sys := map[string]any{"pressure": st.System.Pressure, "cpuPercent": round1(st.System.CPUPercent),
		"totalMemoryMB": toMB(st.System.TotalMemBytes)}
	if st.System.AvailablePercent != nil {
		sys["availablePercent"] = math.Round(*st.System.AvailablePercent)
	}
	out := map[string]any{
		"system":         sys,
		"autoPause":      st.Governor.AutoPause,
		"holdingNewWork": holding,
	}
	if st.Nomi.Usage != nil {
		out["nomi"] = map[string]any{"memoryMB": toMB(st.Nomi.Usage.RSSBytes), "cpuPercent": round1(st.Nomi.Usage.CPUPercent)}
	}
	// 在跑 / 要你处理 / 暂停 / 排队的在前，已完成的在后
	rank := map[string]int{ColRunning: 0, ColPaused: 1, ColTodo: 2, ColDone: 3}
	list := append([]Agent(nil), st.Agents...)
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && rank[list[j].Column] < rank[list[j-1].Column]; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	agents := []any{}
	for i, a := range list {
		if i >= toolListMax {
			out["truncated"] = len(list) - toolListMax
			break
		}
		agents = append(agents, toolAgent(a))
	}
	out["agents"] = agents
	if st.ExternalIdle.Processes > 0 {
		out["idleExternal"] = map[string]any{"processes": st.ExternalIdle.Processes, "memoryMB": toMB(st.ExternalIdle.RSSBytes)}
	}
	return out
}

func toolErr(code, msg string) map[string]any {
	return map[string]any{"ok": false, "error": map[string]any{"code": code, "message": msg}}
}

// whyNotPausable：pause_agent 被拒时给模型的原因
func whyNotPausable(st State, id string) map[string]any {
	for _, a := range st.Agents {
		if a.ID != id {
			continue
		}
		switch {
		case a.Scope == "external":
			return toolErr("read_only", "这是用户自己在终端 / IDE 里开的编程助手，只能看，不能暂停")
		case a.Paused != nil:
			return toolErr("already_paused", "已经在暂停中")
		case a.Kind == "nomi":
			return toolErr("not_pausable", "Nomi 的对话与后台运行跑在内核里，不能暂停；要停就用 delegate_stop")
		case a.Column != ColRunning:
			return toolErr("not_running", "没在跑（"+a.Column+"）")
		case a.NeedsYou != "":
			return toolErr("needs_user", "正在等用户处理（"+a.NeedsYou+"），先别暂停")
		}
		return toolErr("not_pausable", "现在不能暂停（没有在跑的进程）")
	}
	return toolErr("unknown_agent", "没有这个 agent："+id+"。先用 list_agents 查")
}

// Tools：给 Nomi 的看板工具（Available：没有看板服务时不提供）
func (s *Service) Tools() []tools.Definition {
	idOf := func(in any) string {
		o, _ := in.(*util.Obj)
		if o == nil {
			return ""
		}
		return util.Str(o.Get("id"))
	}
	return []tools.Definition{
		{
			Name: "list_agents",
			Description: "看 Agent 看板：系统内存压力（normal / warn / critical）与可用比例、整机 CPU、Nomi 自己的占用，" +
				"以及所有在干活的 agent（正在回答的对话、后台的 Nomi、派出的与工坊里的编程助手、用户在终端里开的），" +
				"各自在哪一列（todo / running / paused / done）、占多少内存与 CPU、要不要用户处理。" +
				"派新的编程助手或后台任务之前、用户说电脑卡 / 慢、问谁在跑时先看这个。readOnly 的是用户自己开的，只能看。",
			Input:    schema(listInputSchema),
			ReadOnly: true,
			Relevant: agentsRelevant,
			Execute: func(context.Context, any, tools.ExecContext) (any, error) {
				return ToolView(s.State(), s.Holding()), nil
			},
		},
		{
			Name: "pause_agent",
			Description: "暂停一个正在跑的编程助手（list_agents 里 pausable 的）：冻结它的进程，不占 CPU，内存由系统回收；" +
				"之后用 resume_agent 继续，这一轮从暂停处接着跑；内存恢复正常后也会自动继续。" +
				"用在内存紧张、电脑卡、或用户要求先停一下的时候。用户在终端里自己开的（readOnly）不能暂停。",
			Input:    schema(agentInputSchema),
			Relevant: agentsRelevant,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				id := idOf(in)
				st, err := s.PauseBy(id, PausedByNomi)
				if err != nil {
					return whyNotPausable(st, id), nil
				}
				for _, a := range st.Agents {
					if a.ID == id {
						return map[string]any{"ok": true, "agent": toolAgent(a)}, nil
					}
				}
				return map[string]any{"ok": true}, nil
			},
		},
		{
			Name:        "resume_agent",
			Description: "继续一个暂停中的编程助手（list_agents 里 column 为 paused 的），这一轮从暂停处接着跑。内存还紧张时先别继续。",
			Input:       schema(agentInputSchema),
			Relevant:    agentsRelevant,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				id := idOf(in)
				st, err := s.Resume(id)
				if err != nil {
					return toolErr("not_paused", "这个 agent 不在暂停中，或不存在。先用 list_agents 查"), nil
				}
				for _, a := range st.Agents {
					if a.ID == id {
						return map[string]any{"ok": true, "agent": toolAgent(a)}, nil
					}
				}
				return map[string]any{"ok": true}, nil
			},
		},
	}
}
