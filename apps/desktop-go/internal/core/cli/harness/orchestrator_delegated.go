package harness

// orchestrator_delegated.go：Nomi 委派出去的 agent 标签只在 Nomi 里看（对话里的子任务卡片、任务页），
// 不进 agent 的会话列表与历史：记下委派用过的会话（backend:sessionId，落盘），历史列表据此跳过。
// 同一种委派接着用上一次的会话：RebindDelegation 把空闲的委派标签交给新的一次委派。

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// maxDelegatedSessions：最多记多少个委派会话（超出丢掉最早的一批；只影响历史里是否隐藏）
const maxDelegatedSessions = 5000

func (o *Orchestrator) delegatedPath() string {
	return filepath.Join(o.d.Root, "delegated-sessions.json")
}

func (o *Orchestrator) delegatedSet() map[string]bool {
	if o.delegatedSessions != nil {
		return o.delegatedSessions
	}
	o.delegatedSessions = map[string]bool{}
	if o.d.Root == "" {
		return o.delegatedSessions
	}
	if v, ok := readJSONFile(o.delegatedPath()); ok {
		if arr, ok := v.([]any); ok {
			for _, x := range arr {
				if k, ok := x.(string); ok && k != "" {
					o.delegatedSessions[k] = true
				}
			}
		}
	}
	return o.delegatedSessions
}

func (o *Orchestrator) noteDelegatedSession(backend, sessionID string) {
	if backend == "" || sessionID == "" {
		return
	}
	set := o.delegatedSet()
	key := backend + ":" + sessionID
	if set[key] {
		return
	}
	set[key] = true
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) > maxDelegatedSessions {
		for _, k := range keys[:len(keys)-maxDelegatedSessions] {
			delete(set, k)
		}
		keys = keys[len(keys)-maxDelegatedSessions:]
	}
	if o.d.Root == "" {
		return
	}
	arr := make([]any, len(keys))
	for i, k := range keys {
		arr[i] = k
	}
	_ = os.MkdirAll(o.d.Root, 0o777)
	_ = utils.WritePrivateFileAtomic(o.delegatedPath(), []byte(util.Stringify(arr)))
}

// IsDelegatedSession：会话是 Nomi 委派用过的（历史列表里不显示）
func (o *Orchestrator) IsDelegatedSession(backend, sessionID string) bool {
	if backend == "" || sessionID == "" {
		return false
	}
	if o.delegatedSet()[backend+":"+sessionID] {
		return true
	}
	for _, k := range o.tabs.Keys() {
		x := o.tab(k)
		if x.Get("backend") == backend && x.Get("cliSessionId") == sessionID {
			d, _ := x.Get("delegation").(*util.Obj)
			return d != nil && d.Get("by") == "nomi"
		}
	}
	return false
}

func appendBoundedID(list any, id string, maxLen int) []any {
	arr, _ := list.([]any)
	out := make([]any, 0, len(arr)+1)
	for _, x := range arr {
		if s, ok := x.(string); ok && s != "" && s != id {
			out = append(out, s)
		}
	}
	if id != "" {
		out = append(out, id)
	}
	if maxLen > 0 && len(out) > maxLen {
		out = out[len(out)-maxLen:]
	}
	return out
}

// RebindDelegation：把空闲、没被接手的委派标签交给新的一次委派（同一种任务接着用它的会话）：
// 换上新的 callId / taskId / goal（并把旧的 callId / taskId 留进 prevCallIds / prevTaskIds），
// 审批计数清零；del.permissionMode 给了就按它设权限档。不能接手时返回 false。
// del.expectTaskId 给了时，标签当前的 taskId 必须还是它（挑选与改写之间没被别的任务领走）——
// 比对和改写在同一次调用里（编排器串行），两个并发任务挑中同一个标签时只有一个能领到。
func (o *Orchestrator) RebindDelegation(id string, del *util.Obj) bool {
	if !o.tabs.Has(id) {
		return false
	}
	tab := o.tab(id)
	d, _ := tab.Get("delegation").(*util.Obj)
	if d == nil || d.Get("by") != "nomi" || truthy(d.Get("takenOver")) || truthy(d.Get("lastError")) || tab.Get("status") != "idle" {
		return false
	}
	if expect, ok := del.Lookup("expectTaskId"); ok && jsStr(expect) != jsStr(d.Get("taskId")) {
		return false
	}
	if oldCall := jsStr(d.Get("callId")); oldCall != "" && oldCall != jsStr(del.Get("callId")) {
		d.Set("prevCallIds", appendBoundedID(d.Get("prevCallIds"), oldCall, 64))
	}
	if oldTask := jsStr(d.Get("taskId")); oldTask != "" && oldTask != jsStr(del.Get("taskId")) {
		d.Set("prevTaskIds", appendBoundedID(d.Get("prevTaskIds"), oldTask, 64))
	}
	for _, k := range []string{"callId", "taskId"} {
		if truthy(del.Get(k)) {
			d.Set(k, del.Get(k))
		} else {
			d.Delete(k)
		}
	}
	goal := jsStr(del.Get("goal"))
	d.Set("goal", clisdk.Slice0(goal, 200))
	if t := clisdk.Slice0(util.JSTrim(jsStr(del.Get("title"))), 60); t != "" {
		tab.Set("title", t)
	} else if g := clisdk.Slice0(util.JSTrim(goal), 40); g != "" && strings.HasPrefix(str(tab, "title"), "Nomi · ") {
		tab.Set("title", "Nomi · "+g)
	}
	if truthy(del.Get("githubAccess")) {
		d.Set("githubAccess", true)
	} else {
		d.Delete("githubAccess")
	}
	if g := sandboxGrantList(del.Get("sandboxGrants")); len(g) > 0 {
		d.Set("sandboxGrants", g)
	} else {
		d.Delete("sandboxGrants")
	}
	d.Set("approvals", util.NewObj("asked", 0.0, "denied", 0.0, "timedOut", 0.0))
	if pm, ok := del.Get("permissionMode").(string); ok && pm != "" && pm != str(tab, "permissionMode") {
		o.tryWarn("harness rebind permission mode failed", func() { o.SetTabPermissionMode(id, pm, PermOpts{Confirmed: true}) })
	}
	d.Delete("lastError")
	o.delegatedUnsent[id] = true
	o.changed()
	return true
}

// RecoverDelegatedTab：委派标签出错后的进程与会话恢复：
//   - dropSession=false：拆掉常驻进程（立即释放几百 MB 内存与卡死的管道/MCP），保留 cliSessionId 标为休眠，下次发消息起新进程续接；
//   - dropSession=true：连续重试仍崩溃时，清掉可能已损坏/超限的 cliSessionId，把已有对话摘要结转到全新会话。
func (o *Orchestrator) RecoverDelegatedTab(id string, dropSession bool) bool {
	if !o.tabs.Has(id) {
		return false
	}
	tab := o.tab(id)
	if tab == nil || o.tabBusy(id) {
		return false
	}
	o.teardownClaudeLive(id)
	if dropSession {
		if truthy(tab.Get("cliSessionId")) {
			tab.Set("cliSessionId", nil)
			o.setCarried(tab, o.TabMessages(id), str(tab, "cwd"))
		}
	} else if truthy(tab.Get("cliSessionId")) {
		o.dormant[id] = true
	}
	o.changed()
	return true
}
