package delegate

// reuse.go：同一种委派接着用上一次的 agent 会话（同一个对话、同一个 agent 标签、同一个目录、同一种任务、
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

// ReuseKeyWithSource：在 ReuseKey 基础上附带来源与官方账号，防止同一 CLI 不同配置复用串台。
func ReuseKeyWithSource(conversationID, cli, source, accountID, cwd, kind, model, effort string) string {
	if conversationID == "" || cli == "" || cwd == "" {
		return ""
	}
	if source == "" && accountID == "" {
		return ReuseKey(conversationID, cli, cwd, kind, model, effort)
	}
	if kind == "" {
		kind = "coding"
	}
	src := source
	if src == "" {
		src = "official"
	}
	return strings.Join([]string{conversationID, cli, src + "@" + accountID, realPath(cwd), kind, model, effort}, "\x1f")
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
		if d == nil || d.Get("by") != "nomi" || util.Truthy(d.Get("takenOver")) || util.Truthy(d.Get("lastError")) || util.Str(d.Get("reuseKey")) != key {
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

// StaleDelegatedTabMs：委派标签闲置多久后自动关掉（同一种委派复用会话只看一小时内的，留一周给对话里的卡片查看）。
// 出错 / 被停下的标签一样留一周：用户还要在里面「继续」（2.3.16 的出错后继续、子代理接着回复），不能提前关。
const StaleDelegatedTabMs = 7 * 24 * 60 * 60_000

// DelegatedTabExpired：这个空闲的委派标签闲置到期、可以关掉了（不看任务状态，由调用方另查）。
// 只看闲置时长：出错（delegation.lastError）不缩短期限。没被 Nomi 委派、被用户接手的不关。
func DelegatedTabExpired(tab *util.Obj, now float64) bool {
	if tab == nil || tab.Get("status") != "idle" {
		return false
	}
	d, _ := tab.Get("delegation").(*util.Obj)
	if d == nil || d.Get("by") != "nomi" || util.Truthy(d.Get("takenOver")) {
		return false
	}
	at, _ := tab.Get("updatedAt").(float64)
	return now-at >= StaleDelegatedTabMs
}
