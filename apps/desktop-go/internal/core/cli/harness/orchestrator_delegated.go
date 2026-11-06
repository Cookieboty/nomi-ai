package harness

// orchestrator_delegated.go：Nomi 委派出去的编程助手标签只在 Nomi 里看（对话里的子任务卡片、任务页），
// 不进编程助手的会话列表与历史：记下委派用过的会话（backend:sessionId，落盘），历史列表据此跳过。
// 同一种委派接着用上一次的会话：RebindDelegation 把空闲的委派标签交给新的一次委派。

import (
	"os"
	"path/filepath"
	"sort"

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

// RebindDelegation：把空闲、没被接手的委派标签交给新的一次委派（同一种任务接着用它的会话）：
// 换上新的 callId / taskId / goal，审批计数清零；del.permissionMode 给了就按它设权限档。不能接手时返回 false。
// del.expectTaskId 给了时，标签当前的 taskId 必须还是它（挑选与改写之间没被别的任务领走）——
// 比对和改写在同一次调用里（编排器串行），两个并发任务挑中同一个标签时只有一个能领到。
func (o *Orchestrator) RebindDelegation(id string, del *util.Obj) bool {
	if !o.tabs.Has(id) {
		return false
	}
	tab := o.tab(id)
	d, _ := tab.Get("delegation").(*util.Obj)
	if d == nil || d.Get("by") != "nomi" || truthy(d.Get("takenOver")) || tab.Get("status") != "idle" {
		return false
	}
	if expect, ok := del.Lookup("expectTaskId"); ok && jsStr(expect) != jsStr(d.Get("taskId")) {
		return false
	}
	for _, k := range []string{"callId", "taskId"} {
		if truthy(del.Get(k)) {
			d.Set(k, del.Get(k))
		} else {
			d.Delete(k)
		}
	}
	d.Set("goal", clisdk.Slice0(jsStr(del.Get("goal")), 200))
	if truthy(del.Get("githubAccess")) {
		d.Set("githubAccess", true)
	} else {
		d.Delete("githubAccess")
	}
	d.Set("approvals", util.NewObj("asked", 0.0, "denied", 0.0, "timedOut", 0.0))
	if pm, ok := del.Get("permissionMode").(string); ok && pm != "" && pm != str(tab, "permissionMode") {
		o.tryWarn("harness rebind permission mode failed", func() { o.SetTabPermissionMode(id, pm, PermOpts{}) })
	}
	o.delegatedUnsent[id] = true
	o.changed()
	return true
}
