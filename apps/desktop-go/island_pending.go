package main

// 灵动岛上「等你处理的事」（HITL）：把各处在等用户拍板的事汇成一份列表推给灵动岛，岛上的按钮接回各自原来的处理接口
// （与对话里、任务页里的按钮是同一个入口，处理完各处一起消失）：
//   - 编程助手标签的权限请求（含批准计划）：harness ReplyPermission / ReplyApprovePlan；
//   - 编程助手被沙箱拦下：harness SandboxReply（受保护的文件夹只能拒绝）；
//   - 持续任务：等批准 / 预算 / 配置 / 被接手（tasks decide）、等验收（accept）、要核对（reconcile）；
//     要写字的（补充信息、退回意见）与重新授权只给「打开」；
//   - Nomi 自己的工具确认（桌面、命令、MCP、委派交接）：desktop AnswerConfirm；强制弹窗的只给「打开」。
// 任务派出的标签上的权限请求同时是任务的「等批准」：只列一次，走任务（否则任务一直卡在等你）；批准计划除外。
// 刷新：标签事件、任务变化、确认请求出现 / 收起时合并刷新一次；另外每 5 秒兜底（超时自动拒绝等没有事件的情况）。

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// islandEndpointName：编程助手的显示名（品牌名，不翻译）
var islandEndpointName = map[string]string{
	"claude": "Claude Code", "codex": "Codex", "gemini": "Gemini CLI", "grok": "Grok", "dsh": "dsh", "nomi": "Nomi",
}

func islandBackendName(b string) string {
	if n, ok := islandEndpointName[b]; ok {
		return n
	}
	if b == "" {
		return "Nomi"
	}
	return b
}

// islandPendingSources：汇总用到的来源（缺的跳过）
type islandPendingSources struct {
	orch    *harness.Orchestrator
	tasks   *tasks.Service
	desktop *desktop.Service
	// open：「打开」= 打开对话窗口并跳到这一条（target：task / tab / nomi，见 islandNavOf）
	open func(target, id string)
}

type islandPendingHub struct {
	isl *island.Service
	src islandPendingSources

	mu       sync.Mutex
	actions  map[string]map[string]func() error // 条目 id → 按钮 id → 处理
	timer    *time.Timer
	stopTick chan struct{}
}

// wireIslandPending：接上来源与灵动岛；返回释放函数
func wireIslandPending(isl *island.Service, src islandPendingSources) func() {
	h := &islandPendingHub{isl: isl, src: src, actions: map[string]map[string]func() error{}, stopTick: make(chan struct{})}
	isl.SetResolver(h.act)
	isl.SetOpener(h.openItem)
	var offs []func()
	if src.orch != nil {
		o := src.orch
		jsrt.Run(func() {
			o.Events().On("tabs", func(any) { h.schedule() })
			o.Events().On("event", func(v any) {
				ev, _ := v.(*util.Obj)
				if ev == nil {
					return
				}
				inner, _ := ev.Get("event").(*util.Obj)
				if inner == nil {
					return
				}
				switch inner.Get("type") {
				case "permission", "permission-resolved", "done", "error":
					h.schedule()
				}
			})
		})
	}
	if src.tasks != nil {
		// 任务变化的回调可能在运行时持锁时触发：只排一次刷新，不在这里读
		offs = append(offs, src.tasks.OnChange(func(string) { h.schedule() }))
	}
	if src.desktop != nil {
		src.desktop.OnConfirmChange(h.schedule)
	}
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				h.refresh()
			case <-h.stopTick:
				return
			}
		}
	}()
	h.schedule()
	return func() {
		close(h.stopTick)
		for _, off := range offs {
			off()
		}
	}
}

// schedule：合并 150ms 内的多次变化，刷新一次
func (h *islandPendingHub) schedule() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.timer != nil {
		h.timer.Stop()
	}
	h.timer = time.AfterFunc(150*time.Millisecond, h.refresh)
}

func (h *islandPendingHub) refresh() {
	list, acts := h.collect()
	h.mu.Lock()
	h.actions = acts
	h.mu.Unlock()
	h.isl.SetPending(list)
}

// openItem：打开对话窗口并跳到这一条所在的地方（「打开」按钮、点这一行）
func (h *islandPendingHub) openItem(id string) {
	if h.src.open == nil {
		return
	}
	target, ref := islandNavOf(id)
	h.src.open(target, ref)
}

// islandNavOf：条目 id → 对话窗口里的去处。编程助手的请求在它的标签里，任务在任务详情，Nomi 的确认在主对话
func islandNavOf(id string) (target, ref string) {
	parts := strings.Split(id, "\x1f")
	switch parts[0] {
	case "perm", "sbx":
		if len(parts) > 1 {
			return "tab", parts[1]
		}
	case "task":
		if len(parts) > 1 {
			return "task", parts[1]
		}
	}
	return "nomi", ""
}

// act：岛上点了按钮（island.Service.Act → resolver）
func (h *islandPendingHub) act(id, action string) error {
	h.mu.Lock()
	fn := h.actions[id][action]
	h.mu.Unlock()
	if fn == nil {
		return island.ErrUnknownPending
	}
	err := fn()
	h.schedule()
	return err
}

// 文案
var (
	islandAllow = func() island.Action {
		return island.Action{ID: "allow", Label: i18n.T("ui.chat-settings.allow"), Primary: true}
	}
	islandDeny = func() island.Action { return island.Action{ID: "deny", Label: i18n.T("ui.chat-settings.deny")} }
	islandOpen = func() island.Action { return island.Action{ID: "open", Label: i18n.T("ui.mascot-theme.island-open")} }
)

var errIslandRejected = errors.New("rejected")

// ok：处理接口返回 false / 不 ok = 这条已经不在了（别处处理过、过期）
func ok(b bool) error {
	if !b {
		return errIslandRejected
	}
	return nil
}

func (h *islandPendingHub) collect() ([]island.Pending, map[string]map[string]func() error) {
	var out []island.Pending
	acts := map[string]map[string]func() error{}
	add := func(p island.Pending, fns map[string]func() error) {
		if h.src.open != nil {
			if _, has := fns["open"]; has {
				id := p.ID
				fns["open"] = func() error { h.openItem(id); return nil }
			}
		}
		out = append(out, p)
		acts[p.ID] = fns
	}
	h.collectTabs(add)
	h.collectTasks(add)
	h.collectConfirms(add)
	return out, acts
}

// collectTabs：编程助手标签的权限请求与沙箱拦截
func (h *islandPendingHub) collectTabs(add func(island.Pending, map[string]func() error)) {
	o := h.src.orch
	if o == nil {
		return
	}
	type tabInfo struct{ title, backend, taskID string }
	var perms []harness.PendingPerm
	tabs := map[string]tabInfo{}
	type sbx struct {
		tab                string
		id, kind, path, op string
		value              string
		at                 float64
	}
	var sandbox []sbx
	jsrt.Call(func() struct{} {
		arr, _ := o.ListTabs().Get("tabs").([]any)
		for _, x := range arr {
			t, _ := x.(*util.Obj)
			if t == nil {
				continue
			}
			id := util.JSString(t.Get("id"))
			info := tabInfo{title: util.Str(t.Get("title")), backend: util.Str(t.Get("backend"))}
			if d, _ := t.Get("delegation").(*util.Obj); d != nil && !util.Truthy(d.Get("takenOver")) {
				info.taskID = util.Str(d.Get("taskId"))
			}
			tabs[id] = info
			sp, _ := t.Get("sandboxPending").([]any)
			for _, y := range sp {
				p, _ := y.(*util.Obj)
				if p == nil {
					continue
				}
				at, _ := p.Get("at").(float64)
				sandbox = append(sandbox, sbx{tab: id, id: util.Str(p.Get("id")), kind: util.Str(p.Get("kind")),
					path: util.Str(p.Get("path")), op: util.Str(p.Get("op")), value: util.Str(p.Get("value")), at: at})
			}
		}
		perms = o.PendingPermissionList()
		return struct{}{}
	})
	for _, p := range perms {
		tab := tabs[p.TabID]
		plan := p.Kind == "approve-plan"
		// 任务派出的标签：普通权限请求就是任务的「等批准」，在任务那边列（走 tasks decide）
		if tab.taskID != "" && !plan {
			continue
		}
		tabID, reqID := p.TabID, p.ID
		name := islandBackendName(tab.backend)
		item := island.Pending{ID: "perm\x1f" + tabID + "\x1f" + reqID, Kind: "permission", Endpoint: tab.backend,
			Title: i18n.T("ui.mascot-theme.island-perm-title", name), Body: p.Summary, At: int64(p.At)}
		reply := func(allow bool) func() error {
			return func() error {
				return ok(jsrt.Call(func() bool { return o.ReplyPermission(tabID, reqID, allow, "", "") }))
			}
		}
		fns := map[string]func() error{"allow": reply(true), "deny": reply(false)}
		item.Actions = []island.Action{islandAllow(), islandDeny()}
		if plan {
			item.Kind = "approve-plan"
			item.Title = i18n.T("ui.mascot-theme.island-plan-title", name)
			planReply := func(choice string) func() error {
				return func() error {
					return ok(jsrt.Call(func() bool { return o.ReplyApprovePlan(tabID, reqID, choice) }))
				}
			}
			label := i18n.T("ui.chat-settings.approve-and-auto-edit")
			if harness.IsExecutePlanID(reqID) {
				label = i18n.T("ui.chat-settings.execute-this-plan")
			}
			item.Actions = []island.Action{
				{ID: "acceptEdits", Label: label, Primary: true},
				{ID: "manual", Label: i18n.T("ui.chat-settings.ask-each-time")},
				{ID: "deny", Label: i18n.T("ui.chat-settings.keep-editing")},
			}
			fns = map[string]func() error{"acceptEdits": planReply("acceptEdits"), "manual": planReply("manual"),
				"deny": planReply("deny")}
		}
		if p.Agent != "" {
			item.Body = p.Agent + " · " + item.Body
		}
		add(item, fns)
	}
	for _, s := range sandbox {
		tab := tabs[s.tab]
		tabID, reqID := s.tab, s.id
		item := island.Pending{ID: "sbx\x1f" + tabID + "\x1f" + reqID, Kind: "sandbox", Endpoint: tab.backend,
			Title: i18n.T("ui.mascot-theme.island-sandbox-title", islandBackendName(tab.backend)),
			Body:  strings.TrimSpace(s.op + " " + s.path), At: int64(s.at)}
		reply := func(choice string) func() error {
			return func() error {
				return ok(jsrt.Call(func() bool { return o.SandboxReply(tabID, reqID, choice) }))
			}
		}
		fns := map[string]func() error{"deny": reply("deny")}
		if s.kind == "protected" {
			// 受保护的文件夹只能在设置里取消保护：岛上只能拒绝，或者打开去处理
			item.Actions = []island.Action{islandOpen(), {ID: "deny", Label: i18n.T("ui.chat-settings.sandbox-deny")}}
			fns["open"] = nil
		} else {
			item.Actions = []island.Action{
				{ID: "session", Label: i18n.T("ui.chat-settings.sandbox-allow-session"), Primary: true},
				{ID: "always", Label: i18n.T("ui.chat-settings.sandbox-allow-always")},
				{ID: "deny", Label: i18n.T("ui.chat-settings.sandbox-deny")},
			}
			fns["session"], fns["always"] = reply("session"), reply("always")
		}
		add(item, fns)
	}
}

// collectTasks：持续任务里在等你的
func (h *islandPendingHub) collectTasks(add func(island.Pending, map[string]func() error)) {
	ts := h.src.tasks
	if ts == nil {
		return
	}
	for _, t := range ts.Inbox() {
		if ts.ConversationOwns(t) {
			continue
		}
		id, gen := t.ID, t.Gen
		endpoint := "nomi"
		if t.Executor.Kind == "cli" && t.Executor.Cli != nil {
			endpoint = *t.Executor.Cli
		}
		item := island.Pending{ID: "task\x1f" + id, Kind: "task", Endpoint: endpoint, Title: t.Title, At: t.UpdatedAt}
		cmd := func(c tasks.Command) func() error {
			return func() error {
				r, err := ts.Command(id, c)
				if err != nil {
					return err
				}
				if !r.OK {
					return fmt.Errorf("%w: %s", errIslandRejected, r.Reason)
				}
				return nil
			}
		}
		decide := func(approve bool) func() error {
			g := gen
			c := tasks.Command{Type: "decide", Gen: &g, Approve: approve}
			if t.Wait != nil && t.Wait.RequestID != nil {
				rid := *t.Wait.RequestID
				c.RequestID = &rid
			}
			return cmd(c)
		}
		detail := ""
		if t.Wait != nil && t.Wait.Detail != nil {
			detail = *t.Wait.Detail
		}
		fns := map[string]func() error{}
		switch t.Status {
		case "waiting_user":
			kind := ""
			if t.Wait != nil {
				kind = t.Wait.Kind
			}
			item.Body = islandJoin(i18n.T(islandWaitLabel(kind)), detail)
			switch kind {
			case "approval", "budget":
				item.Actions = []island.Action{{ID: "approve", Label: i18n.T("ui.providers-schedule.task-approve"), Primary: true}, islandDeny()}
				fns["approve"], fns["deny"] = decide(true), decide(false)
			case "config":
				item.Actions = []island.Action{
					{ID: "approve", Label: i18n.T("ui.providers-schedule.task-config-retry"), Primary: true},
					{ID: "deny", Label: i18n.T("ui.mascot-theme.island-give-up")},
				}
				fns["approve"], fns["deny"] = decide(true), decide(false)
			case "taken_over":
				item.Actions = []island.Action{
					{ID: "approve", Label: i18n.T("ui.providers-schedule.task-mark-done"), Primary: true},
					{ID: "deny", Label: i18n.T("ui.providers-schedule.task-hand-back")},
				}
				fns["approve"], fns["deny"] = decide(true), decide(false)
			default:
				// 要补充信息、重新授权：要写字或再确认一次，去任务页处理
				item.Actions = []island.Action{islandOpen()}
				fns["open"] = nil
			}
		case "awaiting_accept":
			// 退回要写意见：岛上只能通过，退回去任务页
			item.Body = islandJoin(i18n.T("ui.providers-schedule.task-awaiting-accept"), detail)
			item.Actions = []island.Action{{ID: "accept", Label: i18n.T("ui.mascot-theme.island-accept"), Primary: true}, islandOpen()}
			fns["accept"], fns["open"] = cmd(tasks.Command{Type: "accept"}), nil
		case "needs_reconcile":
			item.Body = i18n.T("ui.providers-schedule.task-needs-reconcile")
			item.Actions = []island.Action{
				{ID: "applied", Label: i18n.T("ui.mascot-theme.island-reconcile-applied"), Primary: true},
				{ID: "not_applied", Label: i18n.T("ui.mascot-theme.island-reconcile-not-applied")},
				islandOpen(),
			}
			fns["applied"] = cmd(tasks.Command{Type: "reconcile", Outcome: "applied"})
			fns["not_applied"] = cmd(tasks.Command{Type: "reconcile", Outcome: "not_applied"})
			fns["open"] = nil
		default:
			// 出错、过期：不是等你拍板的事，不上岛
			continue
		}
		add(item, fns)
	}
}

// collectConfirms：Nomi 自己的工具确认（桌面、命令、MCP、委派交接、文件夹授权）
func (h *islandPendingHub) collectConfirms(add func(island.Pending, map[string]func() error)) {
	d := h.src.desktop
	if d == nil || d.Broker == nil {
		return
	}
	for _, r := range d.Broker.PendingRequests() {
		id := r.ID
		item := island.Pending{ID: "confirm\x1f" + id, Kind: "confirm", Endpoint: "nomi",
			Title: i18n.T("ui.mascot-theme.island-confirm-title"), Body: r.Summary, At: int64(r.ExpiresAt)}
		if r.Kind == "scope" {
			item.Title = i18n.T("ui.mascot-theme.island-scope-title")
			item.Body = r.ScopePath
		}
		answer := func(allow bool) func() error {
			return func() error {
				if !d.Broker.HasPending(id) {
					return errIslandRejected
				}
				d.AnswerConfirm("chat", id, allow, false, false)
				return nil
			}
		}
		fns := map[string]func() error{}
		if r.Dialog {
			// 必须看清楚再定的（如发到云端）：去对话窗口里处理
			item.Actions = []island.Action{islandOpen()}
			fns["open"] = nil
		} else {
			allow := islandAllow()
			deny := islandDeny()
			if r.Danger == "destructive" {
				allow.Primary, allow.Danger = false, true
			}
			item.Actions = []island.Action{allow, deny}
			fns["allow"], fns["deny"] = answer(true), answer(false)
		}
		add(item, fns)
	}
}

// islandWaitLabel：任务等你的原因（与任务页同一套文案）
func islandWaitLabel(kind string) string {
	switch kind {
	case "budget":
		return "ui.providers-schedule.task-waiting-budget"
	case "config":
		return "ui.providers-schedule.task-waiting-config"
	case "taken_over":
		return "ui.providers-schedule.task-taken-over"
	case "grant":
		return "ui.providers-schedule.task-waiting-grant"
	case "input":
		return "ui.providers-schedule.task-waiting-input"
	}
	return "ui.providers-schedule.task-waiting-approval"
}

func islandJoin(a, b string) string {
	b = strings.Join(strings.Fields(b), " ")
	if b == "" {
		return a
	}
	return a + " · " + b
}
