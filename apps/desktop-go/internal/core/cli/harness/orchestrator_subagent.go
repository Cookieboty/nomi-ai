package harness

// 子代理（CLI 进程内的 Task / Agent、spawn_agent）：
//   - Codex（app-server）子线程的事件：来源标签这一轮在跑时并进这一轮；空闲时（用户直接对子代理说话、
//     它在后台接着做）不进主列的实时状态，作为 detached 事件推给界面，轨迹事件直接写进派出它的那条消息。
//   - MessageAgent：用户在子任务侧栏里对子代理说的话直接交给子代理本身，不经主代理转述：
//     Codex = 在子线程上 turn/steer / turn/start（v2 子代理不收外部输入时 fork 它的线程）；
//     Claude Code = 子代理结束后，把它自己的会话记录（<项目>/<会话>/subagents/agent-<id>.jsonl）复制成一个
//     独立会话，在一个关联标签里 --resume 接着说（CLI 没有给运行中的子代理发消息的对外接口）。
//   其余 CLI（dsh、ACP）没有可寻址的子代理：返回 unsupported，界面改经主代理转达。

import (
	"bufio"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// maxAppendedTrace：空闲时往一条消息里追加子代理轨迹的上限（超过不再追加，落盘轨迹另有总上限）
const maxAppendedTrace = 600

// onCodexChildEvent：Codex 子线程的一条事件。
func (o *Orchestrator) onCodexChildEvent(tabID string, live *codexLiveSession, raw *util.Obj) {
	if raw == nil {
		return
	}
	ev := clisdk.StampEvent(raw.Clone(), nowMs())
	if ev.Get("type") == "agent" && ev.Get("op") == "end" {
		o.cleanupChildStage(tabID, str(ev, "id"))
	}
	if live.turn != nil && o.partial[tabID] != nil {
		if clisdk.IsTraceEvent(ev) {
			live.turn.events = append(live.turn.events, ev)
		}
		o.emitEvent(tabID, ev)
		return
	}
	o.emitDetached(tabID, ev)
}

// emitDetached：来源标签空闲时的子代理事件：轨迹事件写进派出它的消息；全部带 detached 推给界面
// （界面放进单独的子代理实时状态，不当成主列的这一轮）。
func (o *Orchestrator) emitDetached(tabID string, ev *util.Obj) {
	if o.tab(tabID) == nil {
		return
	}
	if clisdk.IsTraceEvent(ev) {
		o.appendAgentTrace(tabID, ev)
	}
	b := ev.Clone()
	b.Set("tabId", tabID)
	b.Set("detached", true)
	o.eventBatcher.Push(b)
	if ev.Get("type") == "agent" {
		o.trackBackgroundAgent(tabID, ev)
	}
}

// traceHasCall：消息轨迹里有这次调用（或它的子步骤）。
func traceHasCall(trace []any, callID string) bool {
	for _, x := range trace {
		e, _ := x.(*util.Obj)
		if e == nil {
			continue
		}
		if e.Get("parentId") == callID {
			return true
		}
		if e.Get("type") == "tool" && (e.Get("id") == callID || e.Get("detail") == callID) {
			return true
		}
	}
	return false
}

// appendAgentTrace：把空闲时的一条子代理轨迹事件写进派出它的那条助手消息（找不到时写进最后一条助手消息），
// 然后广播这条消息（界面按 id 替换）。
func (o *Orchestrator) appendAgentTrace(tabID string, ev *util.Obj) {
	if tabID == MainTabID {
		return
	}
	parent := str(ev, "parentId")
	list := o.TabMessages(tabID)
	idx := -1
	for i := len(list) - 1; i >= 0; i-- {
		m := list[i]
		if m == nil || m.Get("role") != "assistant" {
			continue
		}
		if idx < 0 {
			idx = i
		}
		if tr, ok := m.Get("trace").([]any); ok && parent != "" && traceHasCall(tr, parent) {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	msg := list[idx]
	tr, _ := msg.Get("trace").([]any)
	if len(tr) >= maxAppendedTrace+clisdk.MaxTraceEvents {
		return
	}
	add := ev.Clone()
	add.Delete("tabId")
	add.Delete("detached")
	add.Delete("itemId")
	msg.Set("trace", append(append([]any{}, tr...), add))
	o.persistMessages(tabID)
	o.post("harness.tabMessage", util.NewObj("tabId", tabID, "message", msg, "updated", true))
}

func (o *Orchestrator) cleanupChildStage(tabID, threadID string) {
	key := tabID + "\x00" + threadID
	if dir := o.childStage[key]; dir != "" {
		cli.CleanupStagedDir(dir)
		delete(o.childStage, key)
	}
}

// MessageAgent = 契约 harness.messageAgent：用户在子任务侧栏里对一个子代理说话，直接交给这个子代理。
// mode：steer（默认；子代理在跑时插进它这一轮）/ queue（在跑时不插，返回 busy，界面等它这一轮结束再发）。
// 结果：{ ok, via: steer | start | fork | resume, tabId? }；不行时 { ok: false, reason }：
// busy（在跑，稍后再发）/ running（Claude 子代理还在跑，结束后才能接着说）/ unsupported（这个 CLI 没有直接通道）/
// not_found（找不到这个子代理的会话记录）/ error（message 里是原因）。
func (o *Orchestrator) MessageAgent(tabID, callID, agentID, text string, images []any, mode string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		tab := o.requireTab(tabID)
		body := clisdk.Slice0(text, 100_000)
		normalized, rejected := cli.InspectImages(images, 8)
		if len(rejected) > 0 {
			throw(cli.RejectedImagesMessage(rejected, 8))
		}
		if util.JSTrim(body) == "" && len(normalized) == 0 {
			return fail("empty"), nil
		}
		switch str(tab, "backend") {
		case "codex":
			return o.messageCodexAgent(tab, callID, agentID, body, normalized, mode != "queue")
		case "claude":
			return o.messageClaudeAgent(tab, callID, agentID, body, images)
		}
		return fail("unsupported"), nil
	})
}

func fail(reason string) *util.Obj { return util.NewObj("ok", false, "reason", reason) }

// agentInput：用户直接对子代理说的话，记进轨迹（子任务侧栏里显示成这个子代理会话里的一条用户消息）。
func agentInput(parentID, text string, normalized []cli.NormalizedImage) *util.Obj {
	ev := util.NewObj("type", "agent-input", "text", text, "parentId", parentID)
	if len(normalized) > 0 {
		ev.Set("images", cli.ImageThumbsForMessage(normalized))
	}
	return clisdk.StampEvent(ev, nowMs())
}

func (o *Orchestrator) messageCodexAgent(tab *util.Obj, callID, threadID, text string, normalized []cli.NormalizedImage, steer bool) (*util.Obj, error) {
	id := str(tab, "id")
	if threadID == "" || !o.usesCodexApp() {
		return fail("unsupported"), nil
	}
	live, err := jsrt.Await(o.ensureCodexLive(tab, jsrt.NewAbortController().Signal))
	if err != nil {
		return util.NewObj("ok", false, "reason", "error", "message", err.Error()), nil
	}
	o.restoreCodexForks(tab, live)
	live.driver.NoteChild(threadID, callID)
	if steer && live.driver.ChildRunning(threadID) && len(normalized) > 0 {
		// turn/steer 只收文字：带图的话等这一轮结束后作为新一轮发
		steer = false
	}
	var input []any
	stageDir := ""
	if len(normalized) > 0 {
		stageDir = filepath.Join(o.promptImageDir(id), "agent-"+clisdk.RandomUUID())
		staged, e := cli.StageImages(stageDir, normalized)
		if e != nil {
			return util.NewObj("ok", false, "reason", "error", "message", e.Error()), nil
		}
		input = cli.CodexTurnInput(text, staged)
	} else {
		input = []any{util.NewObj("type", "text", "text", text, "text_elements", []any{})}
	}
	params := util.NewObj("cwd", str(tab, "cwd"))
	params.Assign(drivers.CodexTurnPolicy(str(tab, "permissionMode"), o.codexNetwork, live.sandboxed, o.extraDirs(tab)))
	via, err := jsrt.Await(live.driver.SendToThread(threadID, input, params, steer))
	if err != nil || via == "busy" {
		if stageDir != "" {
			cli.CleanupStagedDir(stageDir)
		}
		if err != nil {
			if errors.Is(err, drivers.ErrDirectInputRejected) {
				return fail("unsupported"), nil
			}
			return util.NewObj("ok", false, "reason", "error", "message", err.Error()), nil
		}
		return fail("busy"), nil
	}
	target := threadID
	if f := live.driver.ForkOf(threadID); f != "" {
		target = f
		o.rememberCodexFork(tab, threadID, f)
	}
	if stageDir != "" {
		o.childStage[id+"\x00"+target] = stageDir
	}
	key := callID
	if key == "" {
		key = threadID
	}
	o.recordAgentInput(id, live.turn != nil, agentInput(key, text, normalized))
	live.lastActivityAt = nowMs()
	return util.NewObj("ok", true, "via", via), nil
}

// recordAgentInput：来源标签这一轮在跑 → 并进这一轮；否则写进派出它的消息。
func (o *Orchestrator) recordAgentInput(tabID string, inTurn bool, ev *util.Obj) {
	if inTurn && o.partial[tabID] != nil {
		if live := o.live.codex[tabID]; live != nil && live.turn != nil {
			live.turn.events = append(live.turn.events, ev)
		}
		o.emitEvent(tabID, ev)
		return
	}
	o.emitDetached(tabID, ev)
}

// rememberCodexFork / restoreCodexForks：fork 过的 v2 子代理记在标签上（进程重启后仍发给同一个副本）。
func (o *Orchestrator) rememberCodexFork(tab *util.Obj, threadID, fork string) {
	m, _ := tab.Get("agentForks").(*util.Obj)
	if m == nil {
		m = util.NewObj()
	}
	if m.Get(threadID) == fork {
		return
	}
	m.Set(threadID, fork)
	tab.Set("agentForks", m)
	o.changed()
}

func (o *Orchestrator) restoreCodexForks(tab *util.Obj, live *codexLiveSession) {
	m, _ := tab.Get("agentForks").(*util.Obj)
	if m == nil {
		return
	}
	for _, k := range m.Keys() {
		if f, ok := m.Get(k).(string); ok && live.driver.ForkOf(k) == "" {
			live.driver.SetFork(k, f)
		}
	}
}

// claudeAgentRunning：Claude 子代理还在跑（后台任务没结束，或者来源这一轮还在跑）。
func (o *Orchestrator) claudeAgentRunning(tab *util.Obj, agentID string) bool {
	id := str(tab, "id")
	if l := o.live.claude[id]; l != nil && l.bgTasks[agentID] {
		return true
	}
	if m := o.bgAgents[id]; m != nil {
		if _, ok := m.m[agentID]; ok {
			return true
		}
	}
	return tab.Get("status") == "running" || tab.Get("status") == "queued"
}

// subagentTab：之前为这个子代理开的关联标签。
func (o *Orchestrator) subagentTab(parentID, callID, agentID string) *util.Obj {
	for _, k := range o.tabs.Keys() {
		t := o.tab(k)
		s, _ := t.Get("subagentOf").(*util.Obj)
		if s == nil || s.Get("tabId") != parentID {
			continue
		}
		if (agentID != "" && s.Get("agentId") == agentID) || (callID != "" && s.Get("callId") == callID) {
			return t
		}
	}
	return nil
}

func (o *Orchestrator) messageClaudeAgent(tab *util.Obj, callID, agentID, text string, images []any) (*util.Obj, error) {
	id := str(tab, "id")
	if existing := o.subagentTab(id, callID, agentID); existing != nil {
		if existing.Get("status") == "running" || existing.Get("status") == "queued" {
			return fail("busy"), nil
		}
		fid := str(existing, "id")
		jsrt.Go(func() { _, _ = jsrt.Await(o.SendTab(fid, text, images, true)) })
		return util.NewObj("ok", true, "via", "resume", "tabId", fid), nil
	}
	sid, _ := tab.Get("cliSessionId").(string)
	if agentID == "" || sid == "" {
		return fail("unsupported"), nil
	}
	if o.claudeAgentRunning(tab, agentID) {
		return fail("running"), nil
	}
	configDir := usage.ClaudeConfigDir(o.home, usage.ProcessEnv())
	cwd := str(tab, "cwd")
	src := findClaudeAgentTranscript(configDir, cwd, sid, agentID)
	if src == "" {
		return fail("not_found"), nil
	}
	newID := clisdk.RandomUUID()
	// src = <项目>/<会话>/subagents/.../agent-<id>.jsonl；新会话写在 <项目>/<新 id>.jsonl
	if err := forkClaudeTranscript(src, filepath.Join(claudeProjectOf(src, sid), newID+".jsonl"), newID); err != nil {
		return util.NewObj("ok", false, "reason", "error", "message", err.Error()), nil
	}
	label := ""
	if m := o.bgAgents[id]; m != nil {
		if a, ok := m.m[agentID]; ok && a.label != nil {
			label = *a.label
		}
	}
	opts := util.NewObj("backend", "claude", "cwd", cwd, "cliSessionId", newID, "activate", false,
		"permissionMode", tab.Get("permissionMode"),
		"subagentOf", util.NewObj("tabId", id, "callId", callID, "agentId", agentID))
	if label != "" {
		opts.Set("title", label)
	}
	for _, k := range []string{"accountId", "source", "projectId", "modelOverride", "reasoningEffort"} {
		if v := tab.Get(k); truthy(v) {
			opts.Set(k, v)
		}
	}
	created := o.CreateTab(opts)
	fid := str(created, "id")
	jsrt.Go(func() { _, _ = jsrt.Await(o.SendTab(fid, text, images, true)) })
	return util.NewObj("ok", true, "via", "fork", "tabId", fid), nil
}

// findClaudeAgentTranscript：<配置目录>/projects/<项目>/<会话 id>/subagents/**/agent-<id>.jsonl。
func findClaudeAgentTranscript(configDir, cwd, sessionID, agentID string) string {
	if !sessionIDRe.MatchString(sessionID) || strings.ContainsAny(agentID, `/\`) || agentID == "" {
		return ""
	}
	root := filepath.Join(configDir, "projects")
	name := "agent-" + agentID + ".jsonl"
	search := func(project string) string {
		base := filepath.Join(root, project, sessionID, "subagents")
		found := ""
		_ = filepath.WalkDir(base, func(p string, d os.DirEntry, err error) error {
			if err != nil || found != "" {
				return nil
			}
			if !d.IsDir() && d.Name() == name {
				found = p
				return filepath.SkipAll
			}
			return nil
		})
		return found
	}
	if p := search(cli.ClaudeProjectDirName(cwd)); p != "" {
		return p
	}
	ents, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, d := range ents {
		if d.IsDir() {
			if p := search(d.Name()); p != "" {
				return p
			}
		}
	}
	return ""
}

var sessionIDRe = resumeAtRe

// claudeProjectOf：子代理会话记录所在的项目目录（<项目>/<会话 id>/subagents/... 往上找到会话目录的上一级）。
func claudeProjectOf(src, sessionID string) string {
	d := filepath.Dir(src)
	for d != filepath.Dir(d) {
		if filepath.Base(d) == sessionID {
			return filepath.Dir(d)
		}
		d = filepath.Dir(d)
	}
	return filepath.Dir(src)
}

// forkClaudeTranscript：子代理的会话记录 → 一个独立会话（每行的 sessionId 换成新 id，isSidechain 置 false，
// 去掉 agentId），--resume 新 id 时 CLI 接着这段上下文往下说。
func forkClaudeTranscript(src, dst, sessionID string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	n := 0
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		v, err := util.ParseString(string(line))
		o := util.AsObj(v)
		if err != nil || o == nil {
			continue
		}
		if o.Has("sessionId") {
			o.Set("sessionId", sessionID)
		}
		if o.Has("isSidechain") {
			o.Set("isSidechain", false)
		}
		o.Delete("agentId")
		out.WriteString(util.Stringify(o))
		out.WriteByte('\n')
		n++
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if n == 0 {
		return errors.New("empty transcript")
	}
	return os.WriteFile(dst, out.Bytes(), 0o600)
}
