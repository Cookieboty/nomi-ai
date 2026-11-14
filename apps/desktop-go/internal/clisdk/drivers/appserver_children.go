package drivers

// app-server 子代理线程（spawn_agent 派出的线程）：
//   - 事件：app-server 把新建的线程（包括子代理线程）自动挂到所有已初始化的连接上，子线程的通知带着
//     自己的 threadId 到达。这里按子线程转成带 parentId 的事件（正文增量、完整正文、工具步骤、开始 / 结束），
//     parentId 是派出它的 spawn_agent 调用 id（还不知道时用线程 id），子任务侧栏按它归到这个子代理下面。
//   - 直接对话：SendToThread 对子线程本身发 turn/steer（它在跑）或 turn/start（它空闲；线程已卸载时先
//     thread/resume）。multi-agent v2 的子代理不收外部输入（app-server 返回
//     "direct app-server input is not allowed for multi-agent v2 sub-agents"），这时 thread/fork 出它的
//     一份副本（带着它的全部上下文），之后对这个子代理说的话都发给副本。

import (
	"errors"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// appChild：一个子代理线程的状态。
type appChild struct {
	callID  string
	label   string
	turnID  *string
	running bool
	// sending 占住一次直接输入的整个 RPC 链（包括 resume / fork），Await 期间不允许重入。
	sending bool
	// turnVersion：生命周期通知是最终状态来源；迟到的 start 应答不能覆盖它们。
	turnVersion uint64
	// text：正在流式输出的正文（itemId → 已收到的增量）
	text map[string]string
}

// ErrDirectInputRejected：子代理不收外部直接输入（multi-agent v2），并且 fork 也失败了。
var ErrDirectInputRejected = errors.New("direct input rejected")

// ErrUnknownChild：threadID 不是这个连接上已发现的子代理（未登记，或就是主线程）。
var ErrUnknownChild = errors.New("unknown child thread")

const directInputRejected = "direct app-server input is not allowed"

func (d *AppServerDriver) isMainThread(id string) bool {
	return id != "" && d.ThreadID != nil && *d.ThreadID == id
}

// knownChild：threadID 是已登记的子代理（含它的 fork 目标 / 别名），且不是主线程。
func (d *AppServerDriver) knownChild(threadID string) bool {
	if threadID == "" || d.isMainThread(threadID) {
		return false
	}
	if d.children[threadID] != nil {
		return true
	}
	if f := d.forks[threadID]; f != "" && f != threadID && !d.isMainThread(f) && d.children[f] != nil {
		return true
	}
	return false
}

func (d *AppServerDriver) child(threadID string) *appChild {
	if d.children == nil {
		d.children = map[string]*appChild{}
	}
	c := d.children[threadID]
	if c == nil {
		c = &appChild{text: map[string]string{}}
		d.children[threadID] = c
	}
	return c
}

// NoteChild：登记一个子代理线程（threadID）和派出它的调用（callID，可空）。重复登记只补上缺的调用 id。
func (d *AppServerDriver) NoteChild(threadID, callID string) {
	if threadID == "" || (d.ThreadID != nil && threadID == *d.ThreadID) {
		return
	}
	c := d.child(threadID)
	if c.callID == "" {
		c.callID = callID
	}
}

// ChildRunning：这个子代理线程正有一轮在跑。
func (d *AppServerDriver) ChildRunning(threadID string) bool {
	c := d.children[d.forkOf(threadID)]
	return c != nil && c.running
}

// HasActiveChildren：正在运行或直接输入尚未应答的子线程。遍历所有线程而非仅 fork 目标：
// 原子代理与它的副本可能同时工作。调用方与通知处理一样须持 jsrt 锁。
func (d *AppServerDriver) HasActiveChildren() bool {
	for _, c := range d.children {
		if c.running || c.sending {
			return true
		}
	}
	return false
}

// IsChild：threadID 是已登记的子代理线程。
func (d *AppServerDriver) IsChild(threadID string) bool { return d.children[threadID] != nil }

func (d *AppServerDriver) forkOf(threadID string) string {
	if f := d.forks[threadID]; f != "" {
		return f
	}
	return threadID
}

// SetFork：之前 fork 过的子代理（进程重启后从标签上恢复）：之后发给 threadID 的话改发给 fork。
func (d *AppServerDriver) SetFork(threadID, fork string) {
	if threadID == "" || fork == "" {
		return
	}
	if d.forks == nil {
		d.forks = map[string]string{}
	}
	d.forks[threadID] = fork
	src := d.child(threadID)
	c := d.child(fork)
	if c.callID == "" {
		c.callID = src.callID
		if c.callID == "" {
			c.callID = threadID
		}
	}
}

func (d *AppServerDriver) childKey(threadID string, c *appChild) string {
	if c.callID != "" {
		return c.callID
	}
	return threadID
}

func (d *AppServerDriver) emitChild(threadID string, ev Json) {
	d.hub.Emit(O("kind", "harness", "event", ev, "child", threadID))
}

// noteSpawn：主线程（或子线程）的 spawn_agent 调用：它派出的线程登记成子代理，归到这次调用下面。
func (d *AppServerDriver) noteSpawn(item Json) {
	if item == nil || item.Get("type") != "collabAgentToolCall" {
		return
	}
	callID, _ := item.Get("id").(string)
	if ids, ok := item.Get("receiverThreadIds").([]any); ok {
		for _, x := range ids {
			if s, ok := x.(string); ok {
				d.NoteChild(s, callID)
			}
		}
	}
}

// onThreadStarted：新线程的父线程是主线程或已知的子线程 → 它是子代理。
func (d *AppServerDriver) onThreadStarted(params Json) {
	th, _ := params.Get("thread").(*util.Obj)
	if th == nil {
		return
	}
	id, _ := th.Get("id").(string)
	parent, _ := th.Get("parentThreadId").(string)
	if id == "" || parent == "" {
		return
	}
	if (d.ThreadID == nil || parent != *d.ThreadID) && d.children[parent] == nil {
		return
	}
	d.NoteChild(id, "")
	c := d.children[id]
	if c != nil && c.label == "" {
		if s, ok := th.Get("agentNickname").(string); ok && s != "" {
			c.label = s
		} else if s, ok := th.Get("agentRole").(string); ok && s != "" {
			c.label = s
		}
	}
}

// onChildNotification：子代理线程的通知 → 带 parentId 的事件（不进主线程这一轮的正文）。
func (d *AppServerDriver) onChildNotification(threadID string, c *appChild, method string, params Json) {
	key := d.childKey(threadID, c)
	switch method {
	case "turn/started":
		c.turnVersion++
		if id, ok := getp(params.Get("turn"), "id").(string); ok {
			c.turnID = &id
		}
		c.running = true
		ev := O("type", "agent", "op", "start", "id", threadID, "status", "running")
		if c.callID != "" {
			ev.Set("callId", c.callID)
		}
		if c.label != "" {
			ev.Set("label", c.label)
		}
		d.emitChild(threadID, ev)
	case "item/agentMessage/delta":
		item, _ := params.Get("itemId").(string)
		delta, _ := params.Get("delta").(string)
		if delta == "" {
			return
		}
		c.text[item] += delta
		d.emitChild(threadID, O("type", "agent-text-delta", "text", delta, "parentId", key, "itemId", item))
	case "item/started", "item/completed":
		item, _ := params.Get("item").(*util.Obj)
		if item == nil {
			return
		}
		if method == "item/completed" {
			d.noteSpawn(item)
		}
		itemID, _ := item.Get("id").(string)
		if item.Get("type") == "agentMessage" {
			if method != "item/completed" {
				return
			}
			text, _ := item.Get("text").(string)
			if text == "" {
				text = c.text[itemID]
			}
			delete(c.text, itemID)
			if strings.TrimSpace(text) != "" {
				d.emitChild(threadID, O("type", "agent-text", "text", text, "parentId", key, "itemId", itemID))
			}
			return
		}
		if item.Get("type") == "userMessage" || item.Get("type") == "contextCompaction" || d.o.MapItem == nil {
			return
		}
		phase := "completed"
		if method == "item/started" {
			phase = "started"
		}
		for _, ev := range d.o.MapItem(phase, item) {
			switch ev.Get("type") {
			case "text", "text-delta", "done", "user-message", "context", "status":
				continue
			case "agent":
				// 子代理再派出的子代理：照常是 agent 事件（按它自己的调用 id 归位）
				d.emitChild(threadID, ev)
				continue
			}
			x := ev.Clone()
			if !util.Truthy(x.Get("parentId")) {
				x.Set("parentId", key)
			}
			d.emitChild(threadID, x)
		}
	case "turn/completed":
		turn := params.Get("turn")
		if c.turnID != nil {
			if s, ok := getp(turn, "id").(string); ok && s != *c.turnID {
				return
			}
		}
		c.turnVersion++
		c.running = false
		c.turnID = nil
		status := "completed"
		switch getp(turn, "status") {
		case "failed":
			status = "failed"
		case "interrupted":
			status = "stopped"
		}
		ev := O("type", "agent", "op", "end", "id", threadID, "status", status)
		if c.callID != "" {
			ev.Set("callId", c.callID)
		}
		d.emitChild(threadID, ev)
	case "error":
		// app-server may report a terminal child-turn failure before (or
		// without) turn/completed.  Clear the child lifecycle state and emit
		// the same end event used by turn/completed; otherwise the UI keeps
		// the sub-agent in the running state indefinitely.
		if params.Get("willRetry") == true || !c.running {
			return
		}
		c.running = false
		c.turnID = nil
		ev := O("type", "agent", "op", "end", "id", threadID, "status", "failed")
		if c.callID != "" {
			ev.Set("callId", c.callID)
		}
		d.emitChild(threadID, ev)
	}
}

// SendToThread：直接对子代理线程说话。在跑（且 steer 为真）→ turn/steer 进它这一轮；空闲 → turn/start
// 在它的线程上开新一轮（线程已卸载时先 thread/resume）。返回 "steer" / "start" / "fork"；
// 在跑但 steer 为假或插不进去时返回 "busy"（调用方排队，等这一轮结束再发）。
func (d *AppServerDriver) SendToThread(threadID string, input []any, params Json, steer bool) *jsrt.Promise[string] {
	return jsrt.Async(func() (string, error) {
		if d.Closed() {
			return "", errors.New("app-server process exited")
		}
		// 只接受这个标签已经发现的子代理；拒绝主线程和未登记的 id（不会因此新建 child 状态）。
		if !d.knownChild(threadID) {
			return "", ErrUnknownChild
		}
		target := d.forkOf(threadID)
		if d.isMainThread(target) || (d.children[target] == nil && d.children[threadID] == nil) {
			return "", ErrUnknownChild
		}
		// 先占住原 id 与实际目标：两个别名不能在 turn/start 应答前各开一轮，
		// fork / resume 等待期间也不能重复 fork 或被空闲回收。
		reserved := []*appChild{}
		reserve := func(c *appChild) bool {
			for _, held := range reserved {
				if held == c {
					return true
				}
			}
			if c.sending {
				return false
			}
			c.sending = true
			reserved = append(reserved, c)
			return true
		}
		defer func() {
			for _, c := range reserved {
				c.sending = false
			}
		}()
		c := d.children[target]
		if c == nil {
			c = d.children[threadID]
		}
		src := d.children[threadID]
		if src == nil {
			src = c
		}
		if c == nil || src == nil {
			return "", ErrUnknownChild
		}
		if !reserve(src) || !reserve(c) {
			return "busy", nil
		}
		if c.running {
			if !steer || c.turnID == nil {
				return "busy", nil
			}
			_, err := jsrt.Await(d.Conn.Request("turn/steer", O("threadId", target, "expectedTurnId", *c.turnID, "input", input), rpc.RequestOptions{}))
			if err != nil {
				return "busy", nil
			}
			return "steer", nil
		}
		startBusy := errors.New("child thread busy")
		start := func(tid string) error {
			cc := d.children[tid]
			if cc == nil {
				return ErrUnknownChild
			}
			if !reserve(cc) || cc.running {
				return startBusy
			}
			version := cc.turnVersion
			p := O("threadId", tid, "input", input)
			if params != nil {
				p.Assign(params)
			}
			r, err := jsrt.Await(d.Conn.Request("turn/start", p, rpc.RequestOptions{}))
			if err != nil {
				return err
			}
			// stdout 一批里可能已处理 started → completed，甚至又 started 下一轮。
			// 只在没有更新通知时用应答补状态，不能把结束的轮次复活或覆盖新轮次。
			if cc.turnVersion == version {
				if s, ok := getp(getp(r, "turn"), "id").(string); ok && s != "" {
					cc.turnID = &s
				}
				cc.running = true
			}
			return nil
		}
		err := start(target)
		if err != nil && strings.Contains(err.Error(), "thread not found") {
			if _, e := jsrt.Await(d.Conn.Request("thread/resume", O("threadId", target), rpc.RequestOptions{})); e == nil {
				err = start(target)
			}
		}
		if errors.Is(err, startBusy) {
			return "busy", nil
		}
		if err == nil {
			return "start", nil
		}
		if !strings.Contains(err.Error(), directInputRejected) {
			return "", errors.New(rpc.InnermostMessage(err.Error()))
		}
		// multi-agent v2：子代理只听它的主代理。fork 出一份带着它全部上下文的普通线程，直接和副本说话
		r, e := jsrt.Await(d.Conn.Request("thread/fork", O("threadId", target), rpc.RequestOptions{}))
		if e != nil {
			return "", ErrDirectInputRejected
		}
		fork, _ := threadIDOf(r)
		if fork == "" {
			return "", ErrDirectInputRejected
		}
		d.SetFork(threadID, fork)
		if err := start(fork); err != nil {
			if errors.Is(err, startBusy) {
				return "busy", nil
			}
			return "", errors.New(rpc.InnermostMessage(err.Error()))
		}
		return "fork", nil
	})
}

// InterruptThread：打断子代理线程正在跑的这一轮（不等应答）。
func (d *AppServerDriver) InterruptThread(threadID string) {
	target := d.forkOf(threadID)
	c := d.children[target]
	if c == nil || !c.running || c.turnID == nil || d.Closed() {
		return
	}
	d.Conn.Request("turn/interrupt", O("threadId", target, "turnId", *c.turnID), rpc.RequestOptions{})
}

// ForkOf：threadID 被 fork 过时返回副本线程 id。
func (d *AppServerDriver) ForkOf(threadID string) string { return d.forks[threadID] }
