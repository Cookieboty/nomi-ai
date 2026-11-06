package delegate

// reuse.go：同一种委派接着用上一次的编程助手会话（同一个对话、同一个编程助手、同一个目录、同一种任务、
// 同样的模型与思考深度）：会话里的上下文与提示词缓存都还在，省 token 也更快。
// 只复用空闲、没被用户接手、已经有会话、最近用过的标签；上一个任务还没结束（等验收、要返工）的不抢。
// 在 worktree 里做的（别的分支做基线）不复用：worktree 落地后就拆了。

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ReuseWindowMs：多久之内用过的会话才复用（再久提示词缓存早过期了，旧上下文只是负担）
const ReuseWindowMs = 60 * 60_000

// ReuseKey：同一种委派的标识；没有来源对话的不复用（返回空）
func ReuseKey(conversationID, cli, cwd, kind, model, effort string) string {
	if conversationID == "" || cli == "" || cwd == "" {
		return ""
	}
	if kind == "" {
		kind = "coding"
	}
	return strings.Join([]string{conversationID, cli, realPath(cwd), kind, model, effort}, "\x1f")
}

// ExpectTaskIDKey：RebindDelegation 的参数里放挑选时看到的上一个任务 id；标签的 taskId 已经变了
// （挑选到改写之间被别的任务领走了）时不接手，调用方改为新建标签
const ExpectTaskIDKey = "expectTaskId"

// ReuseOwner：tabs 里 id 这个委派标签当前的 taskId（挑选时看到的拥有者，交给 RebindDelegation 比对）
func ReuseOwner(tabs []any, id string) string {
	for _, x := range tabs {
		t, _ := x.(*util.Obj)
		if t == nil || util.Str(t.Get("id")) != id {
			continue
		}
		if d, _ := t.Get("delegation").(*util.Obj); d != nil {
			return util.Str(d.Get("taskId"))
		}
		return ""
	}
	return ""
}

// FindReusableTab：tabs（编排器的标签列表）里找能接着用的委派标签；busy(上一个任务 id) 为真的不用
func FindReusableTab(tabs []any, key string, now float64, busy func(taskID string) bool) string {
	if key == "" {
		return ""
	}
	best, bestAt := "", 0.0
	for _, x := range tabs {
		t, _ := x.(*util.Obj)
		if t == nil {
			continue
		}
		d, _ := t.Get("delegation").(*util.Obj)
		if d == nil || d.Get("by") != "nomi" || util.Truthy(d.Get("takenOver")) || util.Str(d.Get("reuseKey")) != key {
			continue
		}
		if t.Get("status") != "idle" || util.Str(t.Get("cliSessionId")) == "" {
			continue
		}
		at, _ := t.Get("updatedAt").(float64)
		if now-at > ReuseWindowMs {
			continue
		}
		if prev := util.Str(d.Get("taskId")); prev != "" && busy != nil && busy(prev) {
			continue
		}
		if id := util.Str(t.Get("id")); id != "" && at >= bestAt {
			best, bestAt = id, at
		}
	}
	return best
}
