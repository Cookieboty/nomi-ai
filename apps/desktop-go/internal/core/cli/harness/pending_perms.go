package harness

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// 等你批准的权限请求的详情（灵动岛据此列出并直接处理，island_pending.go）。
// pendingPerms 只有计时器，详情只在发出的 permission 事件里：这里在 emitEvent 时记一份，
// 列出时只认 pendingPermOrder 里还在的（被回复、超时、这一轮结束、进程重启都会从那里拿掉），顺手清掉过期的详情。

// PendingPerm：一个还在等的权限请求
type PendingPerm struct {
	TabID, ID string
	// Kind：tool 普通工具 / approve-plan 批准计划（三选一：acceptEdits / manual / deny）
	Kind, Summary, ToolName, Agent string
	At                             float64
}

func (o *Orchestrator) rememberPermission(tabID string, ev *util.Obj) {
	if o.permDetail == nil {
		o.permDetail = map[string]PendingPerm{}
	}
	id := str(ev, "id")
	if id == "" {
		return
	}
	kind := str(ev, "kind")
	if kind == "" {
		kind = "tool"
	}
	o.permDetail[tabID+"\x1f"+id] = PendingPerm{TabID: tabID, ID: id, Kind: kind, Summary: str(ev, "summary"),
		ToolName: str(ev, "toolName"), Agent: str(ev, "agent"), At: nowMs()}
}

// PendingPermissionList：所有标签里还在等的权限请求（标签顺序、每个标签里先来的在前）。要在 GIL 里调
func (o *Orchestrator) PendingPermissionList() []PendingPerm {
	out := []PendingPerm{}
	live := map[string]bool{}
	for _, tabID := range o.tabs.Keys() {
		for _, id := range o.pendingPermOrder[tabID] {
			k := tabID + "\x1f" + id
			if d, ok := o.permDetail[k]; ok {
				live[k] = true
				out = append(out, d)
			}
		}
	}
	for k := range o.permDetail {
		if !live[k] {
			delete(o.permDetail, k)
		}
	}
	return out
}
