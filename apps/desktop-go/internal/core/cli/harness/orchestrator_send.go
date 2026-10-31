package harness

// orchestrator_send.go mirrors Orchestrator.ts 2526–2903（sendTab / 质量记录 / finish / 运行计数）
// 与 4705–4778（trackProgress / emitEvent / 后台子代理）、5288–5311（noteQuality / exitedCause）。

import (
	"errors"
	"os"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// officialProvider = OFFICIAL_PROVIDER。
var officialProvider = map[string]string{"claude": "anthropic", "codex": "openai", "grok": "xai", "gemini": "google", "dsh": "deepseek"}

const (
	burstMs        = 100
	burstMinTokens = 20
)

// ensureDefaultDir = ensureDefaultDir。
func (o *Orchestrator) ensureDefaultDir(dir string) string {
	if def := o.d.DefaultCwd; def != "" && samePath(dir, def) {
		if err := os.MkdirAll(def, 0o777); err != nil {
			o.d.Logger.Warn("harness default cwd create failed", err)
		}
	}
	return dir
}

func newMsgID() string { return clisdk.RandomUUID() }

// SendTab = sendTab(id, prompt, images?, {userInitiated?})（async）。
func (o *Orchestrator) SendTab(id, prompt string, images []any, userInitiated bool) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		tab := o.requireTab(id)
		if tab.Get("backend") == "nomi" {
			throw(i18n.T("electron.common.nomi-backend-is-active-use-the-built-in"))
		}
		o.ensureDefaultDir(str(tab, "cwd"))
		text := clisdk.Slice0(prompt, 100_000)
		normalized, rejected := cli.InspectImages(images, 8)
		if len(rejected) > 0 {
			throw(cli.RejectedImagesMessage(rejected, 8))
		}
		if util.JSTrim(text) == "" && len(normalized) == 0 {
			throw(i18n.T("electron.common.message-is-empty"))
		}
		backend := str(tab, "backend")
		if len(normalized) > 0 && cli.ImageSupportFor(backend) == "none" {
			throw(cli.UnsupportedImageMessage(backend))
		}
		if len(normalized) > 0 {
			if v := o.visionOf(tab); v != nil && v.Get("vision") != true {
				throw(cli.ModelNoVisionMessage(str(v, "model")))
			}
		}
		if d, _ := tab.Get("delegation").(*util.Obj); userInitiated && d != nil && d.Get("by") == "nomi" && !truthy(d.Get("takenOver")) {
			if _, err := jsrt.Await(o.takeOverDelegatedTab(id)); err != nil {
				return nil, err
			}
		}
		current := o.requireTab(id)
		delete(o.delegatedUnsent, id)
		had := o.stopBeforeStart[id]
		delete(o.stopBeforeStart, id)
		stopBeforeStart := had && !userInitiated
		autoOnly := current.Get("status") == "running" && o.isAutoOnly(id)
		if (current.Get("status") == "running" && !autoOnly) || current.Get("status") == "queued" {
			throw(i18n.T("electron.common.previous-turn-still-running"))
		}
		if current.Get("modelScope") != anyOf(o.scopeOf(current)) {
			o.adoptScope(current)
			o.changed()
		}
		modelOf := o.turnModelResolver(current)
		var servedRef *string
		if o.sourceOf(current) == "thirdParty" {
			servedRef = o.effectiveOverrides(current).model
		}
		var thumbs []any
		if len(normalized) > 0 {
			thumbs = cli.ImageThumbsForMessage(normalized)
		}
		userMessageID := newMsgID()
		um := util.NewObj("id", userMessageID, "role", "user", "content", text)
		if len(thumbs) > 0 {
			um.Set("images", thumbs)
		}
		um.Set("timestamp", nowMs())
		o.appendMessage(id, um)
		current.Set("lastError", util.Undefined)
		o.acquire(id)
		jsrt.Await(jsrt.Resolved(struct{}{}))
		if !o.tabs.Has(id) {
			o.release()
			throw(i18n.T("electron.common.tab-was-closed"))
		}
		current.Set("status", "running")
		abort := jsrt.NewAbortController()
		o.sendAborts[id] = abort
		if stopBeforeStart {
			o.stopRequested[id] = true
			abort.Abort()
		}
		startedAt := nowMs()
		delete(o.turnExits, id)
		quality := o.qualityBase(current)
		o.partial[id] = &partialTurn{text: "", breaks: []float64{}, events: []*util.Obj{}, q: &turnQuality{}}
		o.changed()
		runCwd := str(current, "cwd")
		var stored *string
		if !truthy(tab.Get("cliSessionId")) {
			stored = o.carriedText(id)
		}
		var carried *string
		if stored != nil {
			c, _ := cli.FitCarried(*stored, cli.CarriedBudget(backend, usage.Platform()))
			carried = &c
		}
		toCli := cli.WithCarriedContext(carried, text)
		stageDir := ""
		if len(normalized) > 0 {
			stageDir = o.promptImageDir(id)
		}
		defer func() {
			if stageDir != "" {
				cli.CleanupStagedDir(stageDir)
			}
			if o.sendAborts[id] == abort {
				delete(o.sendAborts, id)
			}
			delete(o.partial, id)
			delete(o.turnExits, id)
			delete(o.stopRequested, id)
			o.release()
			if backend != "claude" {
				o.clearBackgroundAgents(id)
			}
		}()
		result, err := o.runTurn(current, backend, toCli, abort, normalized, stageDir, userMessageID)
		if err == nil {
			return o.turnOk(id, tab, current, backend, runCwd, result, servedRef, stored, modelOf, quality, startedAt), nil
		}
		return nil, o.turnFailed(id, current, err, modelOf, quality, startedAt)
	})
}

// runTurn：try 块里的 abort 检查 / 暂存图片 / 按后端分派（throw 转成 error）。
func (o *Orchestrator) runTurn(tab *util.Obj, backend, toCli string, abort *jsrt.AbortController, normalized []cli.NormalizedImage, stageDir, userMessageID string) (res *util.Obj, err error) {
	defer func() {
		if r := recover(); r != nil {
			jt, ok := r.(jsrt.JSThrow)
			if !ok {
				panic(r)
			}
			err = jt
		}
	}()
	if abort.Signal.Aborted() {
		throw(i18n.T("electron.common.aborted"))
	}
	staged := []cli.NormalizedImage{}
	if stageDir != "" && len(normalized) > 0 {
		s, e := cli.StageImages(stageDir, normalized)
		if e != nil {
			return nil, e
		}
		staged = s
	}
	id := str(tab, "id")
	var p *jsrt.Promise[*util.Obj]
	switch backend {
	case "claude":
		p = o.runClaude(tab, toCli, abort.Signal, normalized, userMessageID)
	case "dsh":
		p = o.runDsh(tab, toCli)
	case "grok":
		p = o.runGrokTurn(tab, toCli, abort.Signal, normalized)
	case "gemini", "external":
		p = o.runAcp(tab, toCli, abort.Signal, normalized)
	default:
		p = o.runCodexTurn(tab, toCli, abort.Signal, staged, func(turn CodexTurnRef) {
			o.noteCliTurn(id, userMessageID, util.NewObj("sessionId", turn.SessionID, "turnId", turn.TurnID))
		})
	}
	return jsrt.Await(p)
}

func evs(v any) []*util.Obj {
	switch x := v.(type) {
	case []*util.Obj:
		return x
	case []any:
		out := make([]*util.Obj, 0, len(x))
		for _, e := range x {
			if ob, ok := e.(*util.Obj); ok {
				out = append(out, ob)
			}
		}
		return out
	}
	return []*util.Obj{}
}

func (o *Orchestrator) turnOk(id string, tab, current *util.Obj, backend, runCwd string, result *util.Obj, servedRef, stored *string, modelOf func([]*util.Obj, *util.Obj) any, quality *util.Obj, startedAt float64) *util.Obj {
	if sid, _ := result.Get("sessionId").(string); sid != "" && str(current, "backend") == backend && str(current, "cwd") == runCwd {
		o.bindCliSession(current, sid)
	}
	if servedRef != nil && *servedRef != "" && str(current, "backend") == backend {
		o.noteServed(current, *servedRef)
	}
	if stored != nil {
		o.setCarried(tab, nil, "")
	}
	if current.Has("claudeResumeAt") && current.Get("claudeResumeAt") != nil {
		current.Delete("claudeResumeAt")
		o.changed()
	}
	if l := o.live.claude[id]; l != nil && l.auto != nil {
		current.Set("status", "running")
	} else {
		current.Set("status", "idle")
	}
	events := evs(result.Get("events"))
	tools := []any{}
	byKey := map[string]int{}
	for _, e := range events {
		if e.Get("type") != "tool" {
			continue
		}
		key := str(e, "detail")
		if key == "" {
			key = str(e, "name")
		}
		label := str(e, "name")
		switch e.Get("status") {
		case "error":
			label += " ✗"
		case "done":
			label += " ✓"
		}
		if idx, ok := byKey[key]; ok {
			tools[idx] = label
		} else {
			byKey[key] = len(tools)
			tools = append(tools, label)
		}
	}
	trace := clisdk.BuildTrace(events)
	use := clisdk.MergeUsage(events)
	durationMs := nowMs() - startedAt
	msg := util.NewObj("id", newMsgID(), "role", "assistant", "content", result.Get("text"), "timestamp", nowMs(), "durationMs", durationMs)
	withModel(msg, modelOf(events, use))
	if use != nil {
		msg.Set("usage", use)
	}
	if len(tools) > 0 {
		msg.Set("tools", tools)
	}
	if len(trace) > 0 {
		msg.Set("trace", trace)
	}
	if tb, _ := result.Get("textBreaks").([]any); len(tb) > 0 {
		msg.Set("textBreaks", tb)
	}
	o.appendMessage(id, msg)
	outcome := "ok"
	if o.turnExits[id] {
		outcome = "cli-exit"
	}
	delete(o.turnExits, id)
	m, _ := modelOf(events, use).(string)
	o.recordQuality(id, quality, startedAt, outcome, "", use, m)
	o.finish(current, true, str(result, "text"), nil)
	out := result.Clone()
	out.Set("trace", trace)
	out.Set("durationMs", durationMs)
	if use != nil {
		out.Set("usage", use)
	}
	return out
}

func (o *Orchestrator) turnFailed(id string, current *util.Obj, e error, modelOf func([]*util.Obj, *util.Obj) any, quality *util.Obj, startedAt float64) error {
	message := errMsg(e)
	stopped := o.stopRequested[id]
	delete(o.stopRequested, id)
	part := o.partial[id]
	var partEvents []*util.Obj
	var partCtx *util.Obj
	partText := ""
	if part != nil {
		partEvents, partCtx, partText = part.events, part.context, part.text
	}
	if partEvents == nil {
		partEvents = []*util.Obj{}
	}
	trace := clisdk.BuildTrace(partEvents)
	durationMs := nowMs() - startedAt
	model, _ := modelOf(partEvents, partCtx).(string)
	if o.tabs.Has(id) {
		if stopped {
			current.Set("status", "idle")
			msg := util.NewObj("id", newMsgID(), "role", "assistant", "content", partText, "timestamp", nowMs(), "durationMs", durationMs, "stopped", true)
			withModel(msg, model)
			if len(trace) > 0 {
				msg.Set("trace", trace)
			}
			if part != nil && len(part.breaks) > 0 {
				msg.Set("textBreaks", breaksAny(part.breaks))
			}
			if partCtx != nil {
				msg.Set("usage", partCtx)
			}
			o.appendMessage(id, msg)
			delete(o.progress, id)
			o.changed()
			phase := "before-first"
			if part != nil && part.q != nil && part.q.hasFirst {
				phase = "during"
			}
			o.recordQuality(id, quality, startedAt, "client-cancel", phase, partCtx, model)
		} else {
			current.Set("status", "error")
			current.Set("lastError", message)
			mt := util.JSTrim(message)
			repeated := mt != "" && strings.HasSuffix(jsTrimEnd(partText), mt)
			content := partText + "\n\n" + message
			if util.JSTrim(partText) == "" || repeated {
				content = partText
				if content == "" {
					content = message
				}
			}
			msg := util.NewObj("id", newMsgID(), "role", "assistant", "content", content, "timestamp", nowMs(), "error", true, "durationMs", durationMs)
			withModel(msg, model)
			if partCtx != nil {
				msg.Set("usage", partCtx)
			}
			var ue *gemini.UntrustedError
			if errors.As(e, &ue) && isUntrusted(e) {
				msg.Set("geminiTrust", util.NewObj("folder", ue.Folder, "broad",
					gemini.IsBroadGeminiFolder(ue.Folder, o.home, []string{o.d.LegacyDefaultCwd}, usage.Platform())))
			}
			if len(trace) > 0 {
				msg.Set("trace", trace)
			}
			if util.JSTrim(partText) != "" && part != nil && len(part.breaks) > 0 {
				msg.Set("textBreaks", breaksAny(part.breaks))
			}
			o.appendMessage(id, msg)
			outcome := "cli-error"
			ex := o.turnExits[id]
			delete(o.turnExits, id)
			if ex || exitedCause(e) {
				outcome = "cli-exit"
			}
			o.recordQuality(id, quality, startedAt, outcome, "", partCtx, model)
			o.finish(current, false, "", &message)
		}
	}
	if stopped {
		return &StoppedError{Msg: message, PartialText: partText}
	}
	return e
}

// isUntrusted：e instanceof GeminiUntrustedError（只看最外层，不看 cause 链）。
func isUntrusted(e error) bool { _, ok := e.(*gemini.UntrustedError); return ok }

func jsTrimEnd(s string) string {
	t := util.JSTrim("x" + s)
	return t[1:]
}

// isAutoOnly = isAutoOnly。
func (o *Orchestrator) isAutoOnly(id string) bool {
	l := o.live.claude[id]
	return l != nil && l.auto != nil && l.turn == nil
}

// qualityBase = qualityBase（QualityBase 对象）。
func (o *Orchestrator) qualityBase(tab *util.Obj) *util.Obj {
	client := str(tab, "backend")
	if client == "external" && truthy(tab.Get("pluginId")) {
		client = str(tab, "pluginId")
	}
	if o.sourceOf(tab) == "thirdParty" {
		ref := ""
		if m := o.effectiveOverrides(tab).model; m != nil {
			ref = *m
		}
		b := util.NewObj("client", client, "source", "thirdParty")
		if slash := strings.Index(ref, "/"); slash > 0 {
			b.Set("provider", ref[:slash])
		}
		return b
	}
	prov, ok := officialProvider[str(tab, "backend")]
	if !ok {
		prov = client
	}
	b := util.NewObj("client", client, "source", "official", "provider", prov)
	if truthy(tab.Get("accountId")) {
		b.Set("accountId", tab.Get("accountId"))
	}
	return b
}

func numP(v any) *float64 {
	if f, ok := v.(float64); ok {
		return &f
	}
	if v != nil && v != util.Undefined {
		f := jsToNumber(v)
		return &f
	}
	return nil
}

// recordQuality = recordQuality；cancelPhase / model "" = 缺省，usage nil = undefined。
func (o *Orchestrator) recordQuality(id string, base *util.Obj, startedAt float64, outcome, cancelPhase string, use *util.Obj, model string) {
	sink := o.d.Quality
	if sink == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			o.d.Logger.Warn("harness quality record failed", util.NewObj("error", errMsgAny(r)))
		}
	}()
	var q *turnQuality
	if p := o.partial[id]; p != nil {
		q = p.q
	}
	rel := func(t float64) float64 {
		if t-startedAt < 0 {
			return 0
		}
		return t - startedAt
	}
	if use == nil {
		use = util.NewObj()
	}
	output := numP(use.Get("outputTokens"))
	input := usage.QualityLedgerInput(str(base, "client"), numP(use.Get("inputTokens")), numP(use.Get("cacheReadTokens")))
	rec := util.NewObj("id", newMsgID(), "layer", "cli", "ts", startedAt)
	rec.Assign(base)
	rec.Set("tabId", id)
	if model != "" {
		rec.Set("model", model)
	}
	rec.Set("stream", true)
	rec.Set("outcome", outcome)
	if cancelPhase != "" {
		rec.Set("cancelPhase", cancelPhase)
	}
	timing := util.NewObj()
	if q != nil && q.hasFirst {
		timing.Set("firstContentMs", rel(q.first))
	}
	if q != nil && q.hasFirstText {
		timing.Set("firstTextMs", rel(q.firstText))
	}
	if q != nil && q.hasFirst {
		timing.Set("lastContentMs", rel(q.last))
	}
	timing.Set("endMs", nowMs()-startedAt)
	rec.Set("timing", timing)
	tokens := util.NewObj()
	if input != nil {
		tokens.Set("input", *input)
	}
	if output != nil {
		tokens.Set("output", *output)
	}
	if c := numP(use.Get("cacheReadTokens")); c != nil {
		tokens.Set("cacheRead", *c)
	}
	rec.Set("tokens", tokens)
	if c := numP(use.Get("costUsd")); c != nil {
		rec.Set("cost", *c)
	}
	if q != nil && q.retries != 0 {
		rec.Set("retries", q.retries)
	}
	out := 0.0
	if output != nil {
		out = *output
	}
	if q != nil && q.hasFirst && q.last-q.first < burstMs && out >= burstMinTokens {
		rec.Set("burst", true)
	}
	sink.AddCli(rec)
}

func errMsgAny(r any) any {
	if jt, ok := r.(jsrt.JSThrow); ok {
		return jt.Message
	}
	if e, ok := r.(error); ok {
		return e.Error()
	}
	return util.Undefined
}

// finish = finish(tab, ok, text, error?)。
func (o *Orchestrator) finish(tab *util.Obj, ok bool, text string, errStr *string) {
	id := str(tab, "id")
	delete(o.progress, id)
	background := o.activeTabID != id || !o.appFocused()
	if background && id != MainTabID {
		tab.Set("unread", jsToNumber(tab.Get("unread"))+1)
	}
	o.changed()
	o.events.Emit("tab-finished", TabFinished{TabID: id, Title: str(tab, "title"), Backend: str(tab, "backend"), Ok: ok, Text: text, Error: errStr, Background: background})
	b := str(tab, "backend")
	if ok && tab.Get("permissionMode") == "plan" && (b == "codex" || b == "dsh" || b == "grok") && util.JSTrim(text) != "" {
		o.offerExecutePlan(tab)
	}
}

// offerExecutePlan = offerExecutePlan。
func (o *Orchestrator) offerExecutePlan(tab *util.Obj) {
	id := str(tab, "id")
	timeoutMs := o.PermissionTimeoutMs(id)
	ev := ExecutePlanEvent(id+":"+util.JSString(nowMs()), i18n.T("electron.common.execute-this-plan-switch-to-auto-edit-and"), timeoutMs)
	o.armPermissionTimeout(id, str(ev, "id"))
	o.emitEvent(id, ev)
	o.events.Emit("permission-needed", util.NewObj("tabId", id, "title", tab.Get("title"), "backend", tab.Get("backend"),
		"summary", ev.Get("summary"), "background", o.activeTabID != id || !o.appFocused()))
}

func (o *Orchestrator) acquire(string) { o.running++ }
func (o *Orchestrator) release() {
	if o.running--; o.running < 0 {
		o.running = 0
	}
}

// trackProgress = trackProgress。
func (o *Orchestrator) trackProgress(tabID string, ev *util.Obj) {
	prev, has := o.progress[tabID]
	switch t := ev.Get("type"); {
	case t == "text-delta" || t == "text":
		base := ""
		if has && prev[0] == "text" {
			base = prev[1]
		}
		v := str(ev, "text")
		if t == "text-delta" {
			v = base + v
		}
		o.progress[tabID] = [2]string{"text", clisdk.SliceFrom(v, -400)}
	case t == "tool" && ev.Get("status") == "start":
		v := str(ev, "name")
		if truthy(ev.Get("detail")) {
			v += " " + str(ev, "detail")
		}
		o.progress[tabID] = [2]string{"tool", clisdk.Slice0(v, 160)}
	}
}

// ProgressHint = progressHint（"" = undefined）。
func (o *Orchestrator) ProgressHint(tabID string) string {
	p, ok := o.progress[tabID]
	if !ok || util.JSTrim(p[1]) == "" {
		return ""
	}
	v := util.JSTrim(wsRunRe.ReplaceAllString(p[1], " "))
	if p[0] == "tool" {
		return i18n.T("electron.common.running-named", v)
	}
	return v
}

// slimResult = slimResult：返回给渲染层的结果不含逐条事件。
func slimResult(r *util.Obj) *util.Obj {
	if r == nil {
		return nil
	}
	c := r.Clone()
	c.Delete("events")
	return c
}

// SendReply = sendReply（async）：主标签发送，结果去掉逐条事件。
func (o *Orchestrator) SendReply(prompt string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		r, err := jsrt.Await(o.Send(prompt))
		if err != nil {
			return nil, err
		}
		return slimResult(r), nil
	})
}

// SendTabReply = sendTabReply（async）：用户在标签里发送（userInitiated：接管委派标签）。
func (o *Orchestrator) SendTabReply(id, prompt string, images []any) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		r, err := jsrt.Await(o.SendTab(id, prompt, images, true))
		if err != nil {
			return nil, err
		}
		return slimResult(r), nil
	})
}

var wsRunRe = util.JSRe(`\s+`)

// emitEvent = emitEvent。
func (o *Orchestrator) emitEvent(tabID string, ev *util.Obj) {
	o.trackProgress(tabID, ev)
	if ev.Get("type") == "permission-resolved" && ev.Get("reason") != "allowed" {
		k := "denied"
		if ev.Get("reason") == "timeout" {
			k = "timedOut"
		}
		o.countDelegatedApproval(tabID, k)
	}
	part := o.partial[tabID]
	outgoing := ev
	if part != nil && ev.Get("type") == "context" {
		if ev.Get("tokens") == nil {
			part.context = nil
		} else {
			c := util.NewObj("contextTokens", ev.Get("tokens"))
			if truthy(ev.Get("window")) {
				c.Set("contextWindow", ev.Get("window"))
			}
			if truthy(ev.Get("model")) {
				c.Set("model", ev.Get("model"))
			}
			part.context = c
		}
	}
	if part != nil && part.q != nil {
		noteQuality(part.q, ev, nowMs())
	}
	if part != nil {
		part.text, part.breaks, outgoing = cli.FoldAssistantEvent(part.text, part.breaks, ev)
		if t := outgoing.Get("type"); t == "tool" || t == "thinking" {
			part.events = append(part.events, outgoing)
		}
	}
	b := outgoing.Clone()
	b.Set("tabId", tabID)
	o.eventBatcher.Push(b)
	o.events.Emit("event", util.NewObj("tabId", tabID, "event", outgoing))
	if outgoing.Get("type") == "agent" {
		o.trackBackgroundAgent(tabID, outgoing)
	}
}

// trackBackgroundAgent = trackBackgroundAgent。
func (o *Orchestrator) trackBackgroundAgent(tabID string, ev *util.Obj) {
	m := o.bgAgents[tabID]
	aid := str(ev, "id")
	if ev.Get("op") == "start" && truthy(ev.Get("background")) {
		if m == nil {
			m = &orderedAgents{m: map[string]bgAgent{}}
			o.bgAgents[tabID] = m
		}
		if _, ok := m.m[aid]; !ok {
			a := bgAgent{startedAt: nowMs()}
			if truthy(ev.Get("label")) {
				l := str(ev, "label")
				a.label = &l
			}
			m.m[aid] = a
			m.ids = append(m.ids, aid)
			o.changed()
		}
	} else if ev.Get("op") == "end" && m != nil {
		if _, ok := m.m[aid]; ok {
			delete(m.m, aid)
			m.ids = removeS(m.ids, aid)
			if len(m.ids) == 0 {
				delete(o.bgAgents, tabID)
			}
			o.changed()
		}
	}
}

// clearBackgroundAgents = clearBackgroundAgents。
func (o *Orchestrator) clearBackgroundAgents(tabID string) {
	if _, ok := o.bgAgents[tabID]; ok {
		delete(o.bgAgents, tabID)
		o.changed()
	}
}

// noteQuality = noteQuality。
func noteQuality(q *turnQuality, ev *util.Obj, now float64) {
	t := ev.Get("type")
	if t == "status" {
		if ev.Get("kind") == "retry" {
			q.retries++
		}
		return
	}
	isText := (t == "text-delta" || t == "text") && truthy(ev.Get("text"))
	if t == "text" && q.hasFirstText {
		return
	}
	content := isText || (t == "thinking" && truthy(ev.Get("text"))) || (t == "tool" && ev.Get("status") == "start")
	if !content {
		return
	}
	if !q.hasFirst {
		q.first, q.hasFirst = now, true
	}
	q.last = now
	if isText && !q.hasFirstText {
		q.firstText, q.hasFirstText = now, true
	}
}

// exitedCause = exitedCause（cause 链最多 8 层）。
func exitedCause(e error) bool {
	for i := 0; e != nil && i < 8; i++ {
		if m := e.Error(); m == rpc.RPCExited || m == appServerExited {
			return true
		}
		e = errors.Unwrap(e)
	}
	return false
}
