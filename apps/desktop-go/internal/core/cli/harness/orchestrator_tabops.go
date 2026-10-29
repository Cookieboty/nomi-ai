package harness

// orchestrator_tabops.go mirrors Orchestrator.ts 959–1100（setBackend … send）与
// 1135–2036（createTab … effectiveOverrides）：标签的创建 / 关闭 / 各项设置、模型目录与来源。

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// strP：字符串字段（非字符串 / 缺省 = nil）。
func strP(o *util.Obj, k string) *string {
	if s, ok := o.Get(k).(string); ok {
		return &s
	}
	return nil
}

// trimOrNil = `x?.trim() || null`。
func trimOrNil(v any) *string {
	if s, ok := v.(string); ok {
		if t := util.JSTrim(s); t != "" {
			return &t
		}
	}
	return nil
}

func anyOf(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func isBuiltin(b string) bool { return builtin.IsBuiltinCliID(b) }

// SetBackend = setBackend。
func (o *Orchestrator) SetBackend(backend any) *util.Obj {
	o.SetTabBackend(MainTabID, backend)
	return o.State()
}

// ClearTabCarry = clearTabCarry。
func (o *Orchestrator) ClearTabCarry(id string) *util.Obj {
	tab := o.requireTab(id)
	o.setCarried(tab, nil, "")
	o.changed()
	return tab.Clone()
}

func (o *Orchestrator) findUser(id, messageID string) int {
	for i, m := range o.TabMessages(id) {
		if m.Get("id") == messageID && m.Get("role") == "user" {
			return i
		}
	}
	return -1
}

func msgsCopy(list []*util.Obj) []*util.Obj { return append([]*util.Obj{}, list...) }

// RewindTab = rewindTab（async）。
func (o *Orchestrator) RewindTab(id, messageID string) *jsrt.Promise[[]*util.Obj] {
	return jsrt.Async(func() ([]*util.Obj, error) {
		tab := o.requireTab(id)
		if id == MainTabID {
			throw(i18n.T("electron.common.cannot-write-a-cli-transcript-on-the-main"))
		}
		busy := func() bool { s := tab.Get("status"); return s == "running" || s == "queued" }
		if busy() {
			throw(i18n.T("electron.common.previous-turn-still-running"))
		}
		start := o.findUser(id, messageID)
		if start < 0 {
			throw(i18n.T("electron.common.message-not-found"))
		}
		backend := str(tab, "backend")
		if backend != "claude" && backend != "codex" {
			o.messages[id] = o.TabMessages(id)[:start]
			o.persistMessages(id)
			delete(o.progress, id)
			o.changed()
			return msgsCopy(o.messages[id]), nil
		}
		sessionID := strP(tab, "cliSessionId")
		claudeAt := ""
		codexReverted := false
		if sessionID != nil && *sessionID != "" && backend == "claude" {
			env := usage.ProcessEnv().Clone().Assign(o.launchEnvOf(tab))
			dir := usage.ClaudeConfigDir(o.home, env)
			cwd, sid := str(tab, "cwd"), *sessionID
			claudeAt, _ = jsrt.Await(jsrt.Resolved(cli.ClaudeRewindPoint(dir, cwd, sid, messageID)))
		} else if sessionID != nil && *sessionID != "" && backend == "codex" {
			if turnID := codexRevertTarget(o.TabMessages(id), start, *sessionID); turnID != "" {
				codexReverted, _ = jsrt.Await(o.revertCodexThread(tab, *sessionID, turnID))
			}
		}
		if busy() {
			throw(i18n.T("electron.common.previous-turn-still-running"))
		}
		idx := o.findUser(id, messageID)
		if idx < 0 {
			throw(i18n.T("electron.common.message-not-found"))
		}
		if codexReverted {
			o.teardownAcpLive(id)
		} else {
			o.teardownClaudeLive(id)
		}
		list := o.TabMessages(id)[:idx]
		o.messages[id] = list
		o.persistMessages(id)
		cur := strP(tab, "cliSessionId")
		same := sessionID != nil && cur != nil && *cur == *sessionID
		if same && claudeAt != "" {
			tab.Set("claudeResumeAt", util.NewObj("sessionId", *sessionID, "at", claudeAt))
			o.setCarried(tab, nil, "")
		} else if same && codexReverted {
			tab.Delete("claudeResumeAt")
			o.setCarried(tab, nil, "")
		} else {
			tab.Delete("claudeResumeAt")
			tab.Set("cliSessionId", nil)
			if len(list) > 0 {
				o.setCarried(tab, list, str(tab, "cwd"))
			} else {
				o.setCarried(tab, nil, str(tab, "cwd"))
			}
		}
		delete(o.progress, id)
		o.changed()
		return msgsCopy(list), nil
	})
}

// codexRevertTarget = codexRevertTarget（"" = null）。
func codexRevertTarget(list []*util.Obj, idx int, threadID string) string {
	if idx >= len(list) {
		return ""
	}
	turn, _ := list[idx].Get("cliTurn").(*util.Obj)
	if turn == nil || turn.Get("sessionId") != threadID {
		return ""
	}
	for _, m := range list[:idx] {
		if t, _ := m.Get("cliTurn").(*util.Obj); m.Get("role") == "user" && t != nil && t.Get("sessionId") == threadID {
			s, _ := turn.Get("turnId").(string)
			return s
		}
	}
	return ""
}

// revertCodexThread = revertCodexThread。
func (o *Orchestrator) revertCodexThread(tab *util.Obj, threadID, beforeTurnID string) *jsrt.Promise[bool] {
	return jsrt.Async(func() (bool, error) {
		if !o.usesCodexApp() {
			return false, nil
		}
		live, err := jsrt.Await(o.ensureCodexLive(tab, nil))
		if err == nil {
			if live.turn != nil || live.threadID == nil || *live.threadID != threadID {
				return false, nil
			}
			_, err = jsrt.Await(live.driver.Conn.Request("thread/revert", util.NewObj("threadId", threadID, "beforeTurnId", beforeTurnID), rpc.RequestOptions{}))
			if err == nil {
				return true, nil
			}
		}
		o.d.Logger.Warn("harness codex thread/revert failed", err)
		return false, nil
	})
}

// noteCliTurn = noteCliTurn。
func (o *Orchestrator) noteCliTurn(tabID, messageID string, turn *util.Obj) {
	if o.tab(tabID) == nil {
		return
	}
	for _, m := range o.TabMessages(tabID) {
		if m.Get("id") == messageID {
			m.Set("cliTurn", turn)
			o.persistMessages(tabID)
			return
		}
	}
}

// launchEnvOf = launchEnvOf（launchFor 抛错时 {}）。
func (o *Orchestrator) launchEnvOf(tab *util.Obj) (env *util.Obj) {
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(jsrt.JSThrow); !ok {
				panic(r)
			}
			env = util.NewObj()
		}
	}()
	return o.launchFor(tab).env
}

// SetCwd = setCwd。
func (o *Orchestrator) SetCwd(cwd string, carry bool) *util.Obj {
	o.SetTabCwd(MainTabID, cwd, carry)
	return o.State()
}

// PickCwd = pickCwd。
func (o *Orchestrator) PickCwd() *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		if _, err := jsrt.Await(o.PickTabCwd(MainTabID)); err != nil {
			return nil, err
		}
		return o.State(), nil
	})
}

// Send = send。
func (o *Orchestrator) Send(prompt string) *jsrt.Promise[*util.Obj] {
	return o.SendTab(MainTabID, prompt, nil, false)
}

// ───────────────────────── 标签 ─────────────────────────

// seedMessages：createTab / seedTabMessages 共用的过滤与规整。
func seedMessages(raw []any, now func() float64) []*util.Obj {
	var ok []*util.Obj
	for _, x := range raw {
		m, _ := x.(*util.Obj)
		if m == nil {
			continue
		}
		r := m.Get("role")
		if _, isStr := m.Get("content").(string); (r == "user" || r == "assistant") && isStr {
			ok = append(ok, m)
		}
	}
	if len(ok) > maxTabMessages {
		ok = ok[len(ok)-maxTabMessages:]
	}
	out := []*util.Obj{}
	for _, m := range ok {
		id := m.Get("id")
		if !truthy(id) {
			id = clisdk.RandomUUID()
		}
		ts := m.Get("timestamp")
		if _, isNum := ts.(float64); !isNum {
			ts = now()
		}
		n := util.NewObj("id", id, "role", m.Get("role"), "content", clisdk.Slice0(m.Get("content").(string), 100_000), "timestamp", ts)
		if truthy(m.Get("error")) {
			n.Set("error", true)
		}
		if a, isArr := m.Get("tools").([]any); isArr {
			n.Set("tools", a)
		}
		seedExtras(n, m)
		out = append(out, n)
	}
	return out
}

// seedExtras = seedExtras（直接写进 dst）。
func seedExtras(dst, m *util.Obj) {
	if tr, ok := m.Get("trace").([]any); ok && len(tr) > 0 {
		if len(tr) > 300 {
			tr = tr[:300]
		}
		dst.Set("trace", append([]any{}, tr...))
	}
	if d, ok := m.Get("durationMs").(float64); ok {
		dst.Set("durationMs", d)
	}
	switch u := m.Get("usage").(type) {
	case *util.Obj, []any:
		dst.Set("usage", u)
	}
	if truthy(m.Get("stopped")) {
		dst.Set("stopped", true)
	}
	withModel(dst, m.Get("model"))
}

// CreateTab = createTab(opts)；opts nil = {}。
func (o *Orchestrator) CreateTab(opts *util.Obj) *util.Obj {
	if opts == nil {
		opts = util.NewObj()
	}
	backendV := opts.Get("backend")
	if backendV == nil {
		backendV = "claude"
	}
	if !isBackend(backendV) || backendV == "nomi" {
		throw(i18n.T("electron.common.new-tabs-can-only-use-a-coding-agent"))
	}
	backend := backendV.(string)
	var ext *util.Obj
	if backend == "external" {
		pid, _ := opts.Get("pluginId").(string)
		ext = o.externalSpecOf(pid)
	}
	var cwd string
	if truthy(opts.Get("cwd")) {
		cwd = validDir(jsStr(opts.Get("cwd")))
		o.rememberCwd(cwd)
	} else {
		cwd = o.EnsureDefaultDir(str(o.tab(o.activeTabID), "cwd"))
	}
	now := nowMs()
	sameKind := 0
	for _, k := range o.tabs.Keys() {
		x := o.tab(k)
		if str(x, "backend") == backend && (ext == nil || x.Get("pluginId") == ext.Get("id")) {
			sameKind++
		}
	}
	baseTitle := backendTitle(backend)
	if ext != nil {
		baseTitle = jsStr(ext.Get("displayName"))
	}
	title := ""
	if s, ok := opts.Get("title").(string); ok {
		title = clisdk.Slice0(util.JSTrim(s), 60)
	}
	if title == "" {
		if sameKind > 0 {
			title = fmt.Sprintf("%s %d", baseTitle, sameKind+1)
		} else {
			title = baseTitle
		}
	}
	pm := opts.Get("permissionMode")
	explicit := cli.IsPermissionMode(pm) && pm != "bypass"
	mode := o.newTabMode()
	if explicit {
		mode = pm.(string)
	}
	effMode, _ := cli.EffectiveMode(backend, mode)
	tab := util.NewObj("id", clisdk.RandomUUID(), "title", title, "backend", backend)
	if ext != nil {
		tab.Set("pluginId", ext.Get("id"))
	}
	tab.Set("cwd", cwd).Set("cliSessionId", anyOf(trimOrNil(opts.Get("cliSessionId")))).
		Set("status", "idle").Set("unread", 0.0).Set("createdAt", now).Set("updatedAt", now).
		Set("permissionMode", effMode)
	if truthy(opts.Get("permissionModeSource")) {
		tab.Set("permissionModeSource", opts.Get("permissionModeSource"))
	}
	if del, _ := opts.Get("delegation").(*util.Obj); del != nil {
		d := util.NewObj("by", "nomi")
		if truthy(del.Get("callId")) {
			d.Set("callId", del.Get("callId"))
		}
		d.Set("goal", clisdk.Slice0(jsStr(del.Get("goal")), 200))
		d.Set("approvals", util.NewObj("asked", 0.0, "denied", 0.0, "timedOut", 0.0))
		tab.Set("delegation", d)
	}
	want, _ := opts.Get("source").(string)
	tab.Set("source", o.defaultSource(backend, want))
	if tab.Get("source") == "official" && isAccountBackend(backend) {
		var acc *string
		if truthy(opts.Get("accountId")) {
			s := jsStr(opts.Get("accountId"))
			acc = &s
		} else {
			acc = o.defaultAccountId(backend)
		}
		if acc != nil && *acc != "" {
			tab.Set("accountId", *acc)
		}
	}
	o.inheritSettings(tab, explicit)
	if mo, ok := opts.Get("modelOverride").(string); ok && mo != "" && clisdk.IsValidModelID(mo) {
		tab.Set("modelOverride", mo)
	}
	if ref, ok := opts.Get("lastServedRef").(string); ok && o.sourceOf(tab) == "thirdParty" && ref != "" && clisdk.IsValidModelID(ref) {
		tab.Set("lastServedRef", ref)
		tab.Set("modelOverride", nil)
	}
	if re := opts.Get("reasoningEffort"); truthy(re) && clisdk.IsReasoningEffort(re) {
		tab.Set("reasoningEffort", re)
	}
	id := str(tab, "id")
	o.tabs.Set(id, tab)
	if truthy(opts.Get("delegation")) {
		o.delegatedUnsent[id] = true
	}
	var seeded []*util.Obj
	if raw, ok := opts.Get("messages").([]any); ok {
		seeded = seedMessages(raw, func() float64 { return now })
	} else {
		seeded = []*util.Obj{}
	}
	o.messages[id] = seeded
	if len(seeded) > 0 {
		o.persistMessages(id)
		tab.Set("updatedAt", seeded[len(seeded)-1].Get("timestamp"))
		if !truthy(tab.Get("cliSessionId")) {
			o.setCarried(tab, seeded, "")
		}
	}
	if opts.Get("activate") != false {
		o.activeTabID = id
	}
	o.changed()
	o.prewarm(id)
	return tab.Clone()
}

// OpenSessionKeys = openSessionKeys（插入序）。
func (o *Orchestrator) OpenSessionKeys() []string {
	out := []string{}
	seen := map[string]bool{}
	for _, k := range o.tabs.Keys() {
		x := o.tab(k)
		if sid := x.Get("cliSessionId"); truthy(sid) {
			key := str(x, "backend") + ":" + jsStr(sid)
			if !seen[key] {
				seen[key] = true
				out = append(out, key)
			}
		}
	}
	return out
}

func (o *Orchestrator) findSessionTab(backend, sessionID any) *util.Obj {
	for _, k := range o.tabs.Keys() {
		x := o.tab(k)
		if x.Get("backend") == backend && x.Get("cliSessionId") == sessionID {
			return x
		}
	}
	return nil
}

// SyncOpenSessionTitle = syncOpenSessionTitle。
func (o *Orchestrator) SyncOpenSessionTitle(backend, sessionID string, title any) {
	tab := o.findSessionTab(backend, sessionID)
	next := ""
	if title != nil {
		next = clisdk.Slice0(util.JSTrim(jsStr(title)), 60)
	}
	if tab == nil || next == "" || str(tab, "title") == next || !isGeneratedTabTitle(str(tab, "title"), backend) {
		return
	}
	tab.Set("title", next)
	o.changed()
}

// OpenHistorySession = openHistorySession → {tab, reused}。
func (o *Orchestrator) OpenHistorySession(h *util.Obj) *util.Obj {
	if existing := o.findSessionTab(h.Get("backend"), h.Get("sessionId")); existing != nil {
		o.SetActiveTab(str(existing, "id"))
		return util.NewObj("tab", existing.Clone(), "reused", true)
	}
	opts := util.NewObj("backend", h.Get("backend"), "cwd", h.Get("cwd"), "title", h.Get("title"),
		"messages", h.Get("messages"), "cliSessionId", h.Get("sessionId"))
	if h.Get("source") != "thirdParty" && truthy(h.Get("modelOverride")) {
		opts.Set("modelOverride", h.Get("modelOverride"))
	}
	opts.Set("reasoningEffort", h.Get("reasoningEffort"))
	opts.Set("permissionMode", h.Get("permissionMode"))
	opts.Set("permissionModeSource", h.Get("permissionModeSource"))
	for _, k := range []string{"source", "lastServedRef", "accountId"} {
		if truthy(h.Get(k)) {
			opts.Set(k, h.Get(k))
		}
	}
	return util.NewObj("tab", o.CreateTab(opts), "reused", false)
}

// SeedTabMessages = seedTabMessages。
func (o *Orchestrator) SeedTabMessages(id string, messages []any) *util.Obj {
	tab := o.requireTab(id)
	if id == MainTabID {
		throw(i18n.T("electron.common.cannot-write-a-cli-transcript-on-the-main"))
	}
	seeded := seedMessages(messages, nowMs)
	o.messages[id] = seeded
	o.persistMessages(id)
	if len(seeded) > 0 {
		tab.Set("updatedAt", seeded[len(seeded)-1].Get("timestamp"))
	}
	if !truthy(tab.Get("cliSessionId")) {
		if len(seeded) > 0 {
			o.setCarried(tab, seeded, "")
		} else {
			o.setCarried(tab, nil, "")
		}
	}
	o.changed()
	return tab.Clone()
}

// CloseTab = closeTab。
func (o *Orchestrator) CloseTab(id string) *util.Obj {
	if id == MainTabID {
		throw(i18n.T("electron.common.the-main-chat-tab-cannot-be-closed"))
	}
	tab := o.requireTab(id)
	o.CancelTab(id)
	delete(o.live.claudeStarting, id)
	o.teardownClaudeLive(id)
	order := o.tabs.Keys()
	idx := -1
	for i, k := range order {
		if k == id {
			idx = i
		}
	}
	o.tabs.Delete(id)
	delete(o.messages, id)
	delete(o.delegatedUnsent, id)
	delete(o.stopBeforeStart, id)
	delete(o.tabFileBytes, id)
	delete(o.progress, id)
	o.writer.Cancel(o.messagesPath(id))
	_ = os.RemoveAll(o.messagesPath(id))
	_ = os.RemoveAll(o.carryPath(id))
	if b := str(tab, "backend"); isBuiltin(b) {
		o.dropTabBinding(tab)
		if o.d.Gateway != nil {
			o.d.Gateway.ReleaseAgent(b, id)
		}
	}
	if o.activeTabID == id {
		rest := removeS(order, id)
		i := idx - 1
		if i < 0 {
			i = 0
		}
		if i < len(rest) {
			o.activeTabID = rest[i]
		} else {
			o.activeTabID = MainTabID
		}
	}
	o.changed()
	return o.ListTabs()
}

// RenameTab = renameTab。
func (o *Orchestrator) RenameTab(id string, title any) *util.Obj {
	tab := o.requireTab(id)
	next := ""
	if title != nil {
		next = clisdk.Slice0(util.JSTrim(jsStr(title)), 60)
	}
	if next == "" {
		throw(i18n.T("electron.common.title-cannot-be-empty"))
	}
	tab.Set("title", next)
	o.changed()
	return tab.Clone()
}

// SetActiveTab = setActiveTab。
func (o *Orchestrator) SetActiveTab(id string) *util.Obj {
	tab := o.requireTab(id)
	o.prewarm(str(tab, "id"))
	if o.activeTabID == str(tab, "id") && jsToNumber(tab.Get("unread")) == 0 {
		return o.ListTabs()
	}
	o.activeTabID = str(tab, "id")
	tab.Set("unread", 0.0)
	o.changed()
	return o.ListTabs()
}

var spaceDigitsRe = regexp.MustCompile(`^ \d+$`)

// SetTabBackend = setTabBackend。
func (o *Orchestrator) SetTabBackend(id string, backendV any) *util.Obj {
	tab := o.requireTab(id)
	if !isBackend(backendV) {
		throw(i18n.T("electron.common.unknown-backend"))
	}
	backend := backendV.(string)
	if backend == "nomi" && id != MainTabID {
		throw(i18n.T("electron.common.new-tabs-can-only-use-a-coding-agent"))
	}
	if backend == "external" || tab.Get("backend") == "external" {
		throw(i18n.T("electron.common.an-external-cli-tab-can-t-switch-to"))
	}
	if s := tab.Get("status"); s == "running" || s == "queued" {
		throw(i18n.T("electron.common.previous-turn-still-running"))
	}
	switched := backend != str(tab, "backend")
	if switched {
		o.teardownClaudeLive(id)
		o.teardownCodexLive(id)
		o.teardownAcpLive(id)
		tab.Set("cliSessionId", nil)
		tab.Delete("permissionModeSource")
		oldDefault := backendTitle(str(tab, "backend"))
		title := str(tab, "title")
		if strings.HasPrefix(title, oldDefault) {
			rest := title[len(oldDefault):]
			if rest == "" || spaceDigitsRe.MatchString(rest) {
				sameKind := 0
				for _, k := range o.tabs.Keys() {
					if x := o.tab(k); k != id && x.Get("backend") == backend {
						sameKind++
					}
				}
				if sameKind > 0 {
					tab.Set("title", fmt.Sprintf("%s %d", backendTitle(backend), sameKind+1))
				} else {
					tab.Set("title", backendTitle(backend))
				}
			}
		}
	}
	tab.Set("backend", backend)
	if switched {
		if backend == "nomi" {
			tab.Delete("source")
		} else {
			tab.Set("source", o.defaultSource(backend, ""))
		}
		tab.Set("modelScope", anyOf(o.scopeOf(tab)))
		tab.Delete("modelByScope")
		tab.Delete("lastServedRef")
	}
	m, _ := cli.EffectiveMode(backend, str(tab, "permissionMode"))
	tab.Set("permissionMode", m)
	if switched {
		tab.Set("modelOverride", nil)
		tab.Set("reasoningEffort", nil)
		o.changed()
	}
	return tab.Clone()
}

// defaultSource = defaultSource(backend, want?)；want "" = undefined。
func (o *Orchestrator) defaultSource(backend, want string) string {
	g := o.d.Gateway
	if g == nil || !isBuiltin(backend) {
		return "official"
	}
	d := g.Defaults(backend)
	source := want
	if source == "" {
		source = d.Source
	}
	if source == "thirdParty" && ((d.Model != nil && *d.Model != "") || want != "") {
		return "thirdParty"
	}
	return "official"
}

// defaultAccountId：nil = null。
func (o *Orchestrator) defaultAccountId(backend string) *string {
	g := o.d.Gateway
	if g == nil || !isBuiltin(backend) {
		return nil
	}
	return g.Defaults(backend).AccountId
}

// SetTabSource = setTabSource(id, source, model?)；model nil = undefined。
func (o *Orchestrator) SetTabSource(id string, source any, model *string) *util.Obj {
	tab := o.requireTab(id)
	backend := str(tab, "backend")
	if backend == "nomi" {
		throw(i18n.T("electron.common.nomi-chat-has-no-source-to-choose"))
	}
	if source != "official" && source != "thirdParty" {
		throw(i18n.T("electron.common.unknown-source"))
	}
	if source == "thirdParty" && backend == "external" {
		throw(i18n.T("electron.common.an-external-cli-only-uses-its-own-sign"))
	}
	if source == "thirdParty" && o.d.Gateway == nil {
		throw(i18n.T("electron.common.the-model-gateway-is-unavailable"))
	}
	if s := tab.Get("status"); s == "running" || s == "queued" {
		throw(i18n.T("electron.common.switch-after-this-turn-finishes"))
	}
	ref := ""
	if model != nil {
		ref = util.JSTrim(*model)
	}
	if ref != "" && !clisdk.IsValidModelID(ref) {
		throw(i18n.T("electron.common.invalid-model-name"))
	}
	if source == o.sourceOf(tab) {
		if ref != "" {
			return o.SetTabModel(id, ref, "")
		}
		return tab.Clone()
	}
	if source == "thirdParty" && ref == "" {
		if d := o.d.Gateway.Defaults(backend); d.Model == nil || *d.Model == "" {
			throw(i18n.T("electron.common.assign-a-third-party-model-to-this-coding"))
		}
	}
	hadSession := truthy(tab.Get("cliSessionId")) || len(o.TabMessages(id)) > 0
	o.teardownClaudeLive(id)
	o.teardownCodexLive(id)
	o.teardownAcpLive(id)
	tab.Set("source", source)
	o.adoptScope(tab)
	if ref != "" {
		tab.Set("modelOverride", ref)
	}
	if hadSession && (source == "official" || backend == "codex") {
		tab.Set("cliSessionId", nil)
		o.setCarried(tab, o.TabMessages(id), str(tab, "cwd"))
	}
	o.changed()
	return tab.Clone()
}

// SetTabCwd = setTabCwd。
func (o *Orchestrator) SetTabCwd(id, cwd string, carry bool) *util.Obj {
	tab := o.requireTab(id)
	abs := validDir(cwd)
	if abs != str(tab, "cwd") {
		if tab.Get("status") != "running" {
			o.teardownClaudeLive(id)
			o.teardownCodexLive(id)
			o.teardownAcpLive(id)
		}
		tab.Set("cliSessionId", nil)
		if carry {
			o.setCarried(tab, o.TabMessages(id), str(tab, "cwd"))
		} else {
			o.setCarried(tab, nil, str(tab, "cwd"))
		}
		o.clearTabMessages(id)
	}
	tab.Set("cwd", abs)
	o.rememberCwd(abs)
	o.changed()
	return tab.Clone()
}

// PermOpts = setTabPermissionMode 的 opts（Expect nil = undefined；其字段 nil = undefined）。
type PermOpts struct {
	Confirmed bool
	Expect    *struct{ Backend, Cwd *string }
}

// SetTabPermissionMode = setTabPermissionMode → {...tab, degraded}。
func (o *Orchestrator) SetTabPermissionMode(id string, mode any, opts PermOpts) *util.Obj {
	tab := o.requireTab(id)
	if !cli.IsPermissionMode(mode) {
		throw(i18n.T("electron.common.unknown-permission-mode"))
	}
	if mode == "bypass" && !opts.Confirmed {
		throw(i18n.T("electron.common.full-access-requires-confirmation-first"))
	}
	if w := opts.Expect; mode == "bypass" && w != nil &&
		((w.Backend != nil && *w.Backend != str(tab, "backend")) || (w.Cwd != nil && *w.Cwd != str(tab, "cwd"))) {
		throw(i18n.T("electron.common.this-tab-s-backend-or-working-directory-changed"))
	}
	next, degraded := cli.EffectiveMode(str(tab, "backend"), mode.(string))
	tab.Delete("permissionModeSource")
	if next != str(tab, "permissionMode") {
		tab.Set("permissionMode", next)
		o.rememberSettings(tab)
		if gl := o.live.acp[id]; gl != nil && gl.sessionID != nil && *gl.sessionID != "" && (gl.permissionMode != next || gl.modeChange != nil) {
			o.switchAcpMode(id, gl, next)
		}
		if live := o.live.claude[id]; live != nil && (live.permissionMode != next || live.modeChange != nil) {
			o.switchClaudeMode(id, live, next)
		}
		o.changed()
	}
	return tab.Clone().Set("degraded", degraded)
}

// ApplyTabPermissionMode = applyTabPermissionMode（async）。
func (o *Orchestrator) ApplyTabPermissionMode(id string, mode any, opts PermOpts) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		r := o.SetTabPermissionMode(id, mode, opts)
		// Promise.all([claude?.modeChange?.done, acp?.modeChange?.done])：先拒绝的先报
		var ps []*jsrt.Promise[struct{}]
		if l := o.live.claude[id]; l != nil && l.modeChange != nil {
			ps = append(ps, l.modeChange.done)
		}
		if l := o.live.acp[id]; l != nil && l.modeChange != nil {
			ps = append(ps, l.modeChange.done)
		}
		if _, err := jsrt.Await(promiseAll(ps)); err != nil {
			return nil, err
		}
		if o.bypassInEffect(id) {
			for _, rid := range append([]string{}, o.pendingPermOrder[id]...) {
				o.replyPermission(id, rid, true)
			}
		}
		return o.requireTab(id).Clone().Set("degraded", r.Get("degraded")), nil
	})
}

// promiseAll = Promise.all（只关心结算与第一个拒绝）。
func promiseAll(ps []*jsrt.Promise[struct{}]) *jsrt.Promise[struct{}] {
	out := jsrt.NewPromise[struct{}]()
	left := len(ps)
	if left == 0 {
		// Promise.all([undefined, undefined]) 仍是一个微任务后结算
		out.Resolve(struct{}{})
		return out
	}
	for _, p := range ps {
		p := p
		go func() {
			<-p.Done()
			jsrt.Dispatch(func() {
				if _, err := p.Result(); err != nil {
					out.Reject(err)
					return
				}
				left--
				if left == 0 {
					out.Resolve(struct{}{})
				}
			})
		}()
	}
	return out
}

// switchClaudeMode = switchClaudeMode。
func (o *Orchestrator) switchClaudeMode(id string, live *claudeLiveSession, mode string) {
	change := &modeChange{mode: mode}
	req := o.requestClaudeControl(live, util.NewObj("subtype", "set_permission_mode", "mode", cli.ClaudeModeName(mode)))
	change.done = jsrt.Async(func() (struct{}, error) {
		_, err := jsrt.Await(req)
		if err == nil {
			if o.live.claude[id] == live {
				live.permissionMode = mode
			}
			if live.modeChange == change {
				live.modeChange = nil
			}
			return struct{}{}, nil
		}
		if live.modeChange != change {
			return struct{}{}, nil
		}
		live.modeChange = nil
		if o.live.claude[id] == live {
			o.teardownClaudeLive(id)
		}
		return struct{}{}, fmt.Errorf("%s", i18n.T("electron.common.claude-code-did-not-confirm-the-permission-mode", errMsg(err)))
	})
	live.modeChange = change
}

// switchAcpMode = switchAcpMode。
func (o *Orchestrator) switchAcpMode(id string, gl *acpLiveSession, mode string) {
	modeID := cli.AcpModeID(gl.backend, mode)
	if modeID == "" {
		gl.permissionMode = mode
		return
	}
	change := &modeChange{mode: mode}
	req := gl.driver.SetPermissionMode(modeID)
	change.done = jsrt.Async(func() (struct{}, error) {
		_, err := jsrt.Await(req)
		if err == nil {
			if o.live.acp[id] == gl {
				gl.permissionMode = mode
			}
			if gl.modeChange == change {
				gl.modeChange = nil
			}
			return struct{}{}, nil
		}
		if gl.modeChange != change {
			return struct{}{}, nil
		}
		gl.modeChange = nil
		if o.live.acp[id] == gl {
			o.teardownAcpLive(id)
		}
		why := rpc.InnermostMessage(errMsg(err))
		key := "electron.common.gemini-did-not-confirm-the-permission-mode-change"
		if gl.backend == "grok" {
			key = "electron.common.grok-did-not-confirm-the-permission-mode-change"
		}
		return struct{}{}, fmt.Errorf("%s", i18n.T(key, why))
	})
	gl.modeChange = change
}

// ModelCatalogFor = modelCatalogFor(backend, {refresh, source})；结果 nil = null。
func (o *Orchestrator) ModelCatalogFor(backend string, refresh bool, source string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		o.adoptScopes(backend)
		if !isBuiltin(backend) {
			return nil, nil
		}
		if source == "thirdParty" {
			return o.gatewayCatalog(backend), nil
		}
		if !cli.SupportsModelOverride(backend) {
			return nil, nil
		}
		if c, ok := o.modelCatalogs[backend]; ok && !refresh && nowMs()-c.at < modelCatalogTTLMs {
			return c.catalog, nil
		}
		if inflight := o.modelCatalogInflight[backend]; inflight != nil {
			return jsrt.Await(inflight)
		}
		gen := o.modelCatalogGen[backend]
		current := func() bool { return o.modelCatalogGen[backend] == gen }
		var claudeEnv *util.Obj
		if backend == "claude" {
			claudeEnv = o.childEnv(false, o.officialLaunchFor("claude", nil), nil)
		}
		deps := cli.ModelDiscoveryDeps{
			Spawn: func(b string, args []string) clisdk.ChildLike {
				bin := ResolveHarnessBin(b)
				if bin == "" {
					return nil
				}
				useNode := IsScript(bin)
				l := o.officialLaunchFor(b, nil)
				cmd, full := bin, append(append([]string{}, args...), l.args...)
				if useNode {
					cmd, full = nodeExecPath(), append([]string{bin}, full...)
				}
				return SpawnHarness(cmd, full, os.TempDir(), o.childEnv(useNode, l, nil), "models:"+b)
			},
		}
		if claudeEnv != nil {
			cd := &cli.ClaudeDefaults{SettingsPath: sp(filepath.Join(usage.ClaudeConfigDir(o.home, claudeEnv), "settings.json"))}
			if v, ok := claudeEnv.Get("CLAUDE_CODE_EFFORT_LEVEL").(string); ok {
				cd.EffortEnv = &v
			}
			deps.ClaudeDefaults = cd
		}
		if ch := os.Getenv("CODEX_HOME"); ch != "" {
			deps.CodexConfigPath = filepath.Join(ch, "config.toml")
		} else {
			deps.CodexConfigPath = filepath.Join(o.home, ".codex", "config.toml")
		}
		gh := usage.GrokHomeDir(o.home, usage.ProcessEnv())
		deps.GrokModelsCachePath = filepath.Join(gh, "models_cache.json")
		deps.GrokSettingsCachePath = filepath.Join(gh, "settings_cache.json")
		disc := cli.DiscoverModels(backend, deps)
		var run *jsrt.Promise[*util.Obj]
		run = jsrt.Async(func() (*util.Obj, error) {
			catalog, err := jsrt.Await(disc)
			if err != nil {
				e := errMsg(err)
				o.d.Logger.Warn("harness model discovery failed", util.NewObj("backend", backend, "error", e))
				catalog = util.NewObj("backend", backend, "models", []any{}, "defaultModel", nil, "error", e)
			}
			if current() {
				if truthy(catalog.Get("error")) {
					delete(o.modelCatalogs, backend)
				} else {
					o.modelCatalogs[backend] = catalogEntry{at: nowMs(), catalog: catalog}
				}
			}
			jsrt.QueueMicrotask(func() {
				if o.modelCatalogInflight[backend] == run {
					delete(o.modelCatalogInflight, backend)
				}
			})
			return catalog, nil
		})
		o.modelCatalogInflight[backend] = run
		return jsrt.Await(run)
	})
}

// gatewayCatalog = gatewayCatalog。
func (o *Orchestrator) gatewayCatalog(backend string) *util.Obj {
	g := o.d.Gateway
	var def *string
	models := []any{}
	if g != nil {
		for _, m := range g.Models() {
			x := util.NewObj("id", m.Ref, "label", m.Provider+" / "+m.Label, "reasoning", false, "efforts", []any{})
			if m.Vision != nil {
				x.Set("vision", *m.Vision)
			}
			models = append(models, x)
		}
		def = g.Defaults(backend).Model
	}
	var dm any
	if def != nil && *def != "" {
		for _, x := range models {
			if x.(*util.Obj).Get("id") == *def {
				dm = x
				break
			}
		}
	}
	return util.NewObj("backend", backend, "models", models, "defaultModel", dm,
		"provider", util.NewObj("id", gatewayScope, "name", i18n.T("electron.common.third-party-models")))
}

// visionOf = visionOf（nil = null）。
func (o *Orchestrator) visionOf(tab *util.Obj) *util.Obj {
	backend := str(tab, "backend")
	if backend == "nomi" {
		return nil
	}
	own := trimOrNil(tab.Get("modelOverride"))
	if o.sourceOf(tab) == "thirdParty" {
		ref := own
		if ref == nil && o.d.Gateway != nil {
			ref = o.d.Gateway.Defaults(backend).Model
		}
		if ref == nil || *ref == "" || o.d.Gateway == nil {
			return nil
		}
		for _, m := range o.d.Gateway.Models() {
			if m.Ref == *ref {
				if m.Vision == nil {
					return nil
				}
				return util.NewObj("model", m.Provider+" / "+m.Label, "vision", *m.Vision)
			}
		}
		return nil
	}
	cat := o.cachedCatalog(backend)
	var m *util.Obj
	if own != nil {
		ms, _ := cat.Get("models").([]any)
		for _, x := range ms {
			if xo, _ := x.(*util.Obj); xo != nil && xo.Get("id") == *own {
				m = xo
				break
			}
		}
	} else {
		m, _ = cat.Get("defaultModel").(*util.Obj)
	}
	if m == nil || !m.Has("vision") {
		return nil
	}
	label := m.Get("label")
	if label == nil {
		label = m.Get("id")
	}
	return util.NewObj("model", label, "vision", m.Get("vision"))
}

// turnModelResolver = turnModelResolver。
func (o *Orchestrator) turnModelResolver(tab *util.Obj) func(events []*util.Obj, usage *util.Obj) any {
	if str(tab, "backend") == "nomi" {
		return func([]*util.Obj, *util.Obj) any { return nil }
	}
	picked := o.effectiveOverrides(tab).model
	if o.sourceOf(tab) == "thirdParty" {
		return func([]*util.Obj, *util.Obj) any { return anyOf(picked) }
	}
	fallback := anyOf(picked)
	if fallback == nil {
		if dm, _ := o.cachedCatalog(str(tab, "backend")).Get("defaultModel").(*util.Obj); dm != nil {
			fallback = dm.Get("id")
		}
	}
	return func(events []*util.Obj, u *util.Obj) any {
		if m := u.Get("model"); m != nil {
			return m
		}
		if r := reportedModel(events); r != "" {
			return r
		}
		return fallback
	}
}

// cachedCatalog：nil = null。
func (o *Orchestrator) cachedCatalog(backend string) *util.Obj {
	if c, ok := o.modelCatalogs[backend]; ok {
		return c.catalog
	}
	return nil
}

// SetTabModel = setTabModel(id, model, {expectSource})；expectSource "" = undefined。
func (o *Orchestrator) SetTabModel(id, model, expectSource string) *util.Obj {
	tab := o.requireTab(id)
	backend := str(tab, "backend")
	if !o.canOverride(tab) {
		throw(i18n.T("electron.common.this-coding-assistant-doesn-t-support-switching-models"))
	}
	if expectSource != "" && expectSource != o.sourceOf(tab) {
		throw(i18n.T("electron.common.this-tab-s-model-source-has-changed-pick"))
	}
	name := util.JSTrim(model)
	scope := o.adoptScope(tab)
	if name == "" {
		if truthy(tab.Get("modelOverride")) || truthy(tab.Get("reasoningEffort")) {
			tab.Set("modelOverride", nil)
			tab.Set("reasoningEffort", nil)
			o.rememberSettings(tab)
			o.changed()
			o.recycleLiveForOverride(tab)
		}
		return tab.Clone()
	}
	if !clisdk.IsValidModelID(name) {
		throw(i18n.T("electron.common.invalid-model-name"))
	}
	if scope != nil && o.d.Gateway != nil {
		found := false
		for _, m := range o.d.Gateway.Models() {
			if m.Ref == name {
				found = true
				break
			}
		}
		if !found {
			throw(i18n.T("electron.common.isn-t-among-the-third-party-models-enable", name))
		}
	}
	if tab.Get("modelOverride") != name {
		tab.Set("modelOverride", name)
		tab.Set("modelScope", anyOf(scope))
		if scope != nil {
			tab.Set("reasoningEffort", nil)
		} else if e := clisdk.SanitizeEffort(o.cachedCatalog(backend), &name, tab.Get("reasoningEffort")); e != "" {
			tab.Set("reasoningEffort", e)
		} else {
			tab.Set("reasoningEffort", nil)
		}
		o.rememberSettings(tab)
		o.changed()
		o.recycleLiveForOverride(tab)
	}
	return tab.Clone()
}

// SetTabReasoningEffort = setTabReasoningEffort（effort nil = null）。
func (o *Orchestrator) SetTabReasoningEffort(id string, effort any) *util.Obj {
	tab := o.requireTab(id)
	backend := str(tab, "backend")
	if effort == nil {
		if truthy(tab.Get("reasoningEffort")) {
			tab.Set("reasoningEffort", nil)
			o.rememberSettings(tab)
			o.changed()
			o.recycleLiveForOverride(tab)
		}
		return tab.Clone()
	}
	if !o.canOverride(tab) {
		throw(i18n.T("electron.common.this-coding-assistant-doesn-t-support-switching-models"))
	}
	if o.adoptScope(tab) != nil {
		throw(i18n.T("electron.common.reasoning-effort-can-t-be-set-here-for"))
	}
	if !clisdk.IsReasoningEffort(effort) {
		throw(i18n.T("electron.common.unknown-reasoning-effort"))
	}
	levels, st := clisdk.EffortsForModel(o.cachedCatalog(backend), strP(tab, "modelOverride"))
	if st == 1 {
		throw(i18n.T("electron.common.this-model-doesn-t-support-reasoning-effort"))
	}
	if st == 2 {
		ok := false
		for _, l := range levels {
			if l == effort {
				ok = true
			}
		}
		if !ok {
			throw(i18n.T("electron.common.this-model-doesn-t-support-that-reasoning-effort"))
		}
	}
	if tab.Get("reasoningEffort") != effort {
		tab.Set("reasoningEffort", effort)
		o.rememberSettings(tab)
		o.changed()
		o.recycleLiveForOverride(tab)
	}
	return tab.Clone()
}

// SetTabLongContext = setTabLongContext（on nil = null）。
func (o *Orchestrator) SetTabLongContext(id string, on *bool) *util.Obj {
	tab := o.requireTab(id)
	if o.sourceOf(tab) != "thirdParty" {
		throw(i18n.T("electron.common.long-context-is-only-for-third-party-models"))
	}
	model := o.effectiveOverrides(tab).model
	if model == nil || *model == "" {
		throw(i18n.T("electron.common.this-tab-has-no-third-party-model-yet"))
	}
	var next any
	if on != nil {
		next = util.NewObj("model", *model, "on", *on)
	}
	var curOn any
	if lc, _ := tab.Get("longContext").(*util.Obj); lc != nil && lc.Get("model") == *model {
		curOn = lc.Get("on")
	}
	var nextOn any
	if on != nil {
		nextOn = *on
	}
	if curOn == nextOn {
		return tab.Clone()
	}
	if jsToNumber(tab.Get("background")) > 0 {
		throw(i18n.T("electron.common.background-tasks-are-still-running-switch-long"))
	}
	tab.Set("longContext", next)
	o.changed()
	return tab.Clone()
}

// longContextOf：nil = undefined。
func (o *Orchestrator) longContextOf(tab *util.Obj, model string) *bool {
	if lc, _ := tab.Get("longContext").(*util.Obj); lc != nil && lc.Get("model") == model {
		if b, ok := lc.Get("on").(bool); ok {
			return &b
		}
	}
	return nil
}

// recycleLiveForOverride = recycleLiveForOverride。
func (o *Orchestrator) recycleLiveForOverride(tab *util.Obj) {
	if str(tab, "backend") != "claude" {
		return
	}
	id := str(tab, "id")
	live := o.live.claude[id]
	if live != nil && eqStrP(live.reasoningEffort, o.effectiveOverrides(tab).effort) {
		return
	}
	if live != nil && live.turn == nil && !claudeBackgroundActive(live) {
		o.teardownClaudeLive(id)
	}
}

// sourceOf = sourceOf。
func (o *Orchestrator) sourceOf(tab *util.Obj) string {
	if isBuiltin(str(tab, "backend")) && tab.Get("source") == "thirdParty" && o.d.Gateway != nil {
		return "thirdParty"
	}
	return "official"
}

// scopeOf：nil = null。
func (o *Orchestrator) scopeOf(tab *util.Obj) *string {
	if o.sourceOf(tab) == "thirdParty" {
		return sp(gatewayScope)
	}
	return nil
}

// canOverride = canOverride。
func (o *Orchestrator) canOverride(tab *util.Obj) bool {
	b := str(tab, "backend")
	if b == "nomi" {
		return false
	}
	return o.sourceOf(tab) == "thirdParty" || cli.SupportsModelOverride(b)
}

// adoptScope = adoptScope（nil = null）。
func (o *Orchestrator) adoptScope(tab *util.Obj) *string {
	scope := o.scopeOf(tab)
	had := strP(tab, "modelScope")
	if eqStrP(had, scope) {
		return scope
	}
	key := func(s *string) string {
		if s == nil {
			return "official"
		}
		return *s
	}
	stash := util.NewObj()
	if mb, _ := tab.Get("modelByScope").(*util.Obj); mb != nil {
		stash = mb.Clone()
	}
	if truthy(tab.Get("modelOverride")) || truthy(tab.Get("reasoningEffort")) {
		stash.Set(key(had), util.NewObj("model", tab.Get("modelOverride"), "effort", tab.Get("reasoningEffort")))
	} else {
		stash.Delete(key(had))
	}
	next, _ := stash.Get(key(scope)).(*util.Obj)
	stash.Delete(key(scope))
	tab.Set("modelOverride", next.Get("model"))
	if scope != nil {
		tab.Set("reasoningEffort", nil)
	} else {
		tab.Set("reasoningEffort", next.Get("effort"))
	}
	tab.Set("modelScope", anyOf(scope))
	if stash.Len() > 0 {
		tab.Set("modelByScope", stash)
	} else {
		tab.Set("modelByScope", util.Undefined)
	}
	return scope
}

// adoptScopes = adoptScopes。
func (o *Orchestrator) adoptScopes(backend string) {
	moved := false
	for _, k := range o.tabs.Keys() {
		tab := o.tab(k)
		if str(tab, "backend") != backend || eqStrP(strP(tab, "modelScope"), o.scopeOf(tab)) {
			continue
		}
		o.adoptScope(tab)
		moved = true
	}
	if moved {
		o.changed()
	}
}

// sessionRef：nil = null。
func (o *Orchestrator) sessionRef(tab *util.Obj) *string {
	ref := strP(tab, "lastServedRef")
	if ref == nil || *ref == "" || o.d.Gateway == nil {
		return nil
	}
	for _, m := range o.d.Gateway.Models() {
		if m.Ref == *ref {
			return ref
		}
	}
	return nil
}

// effectiveOverrides = effectiveOverrides。
func (o *Orchestrator) effectiveOverrides(tab *util.Obj) overrides {
	scope := o.scopeOf(tab)
	ms := strP(tab, "modelScope")
	if scope != nil {
		var own *string
		if eqStrP(ms, scope) {
			own = trimOrNil(tab.Get("modelOverride"))
		}
		if own == nil {
			own = o.sessionRef(tab)
		}
		if own == nil && o.d.Gateway != nil {
			if m := o.d.Gateway.Defaults(str(tab, "backend")).Model; m != nil && *m != "" {
				own = m
			}
		}
		return overrides{model: own}
	}
	if ms != nil {
		return overrides{}
	}
	return overrides{model: trimOrNil(tab.Get("modelOverride")), effort: strP(tab, "reasoningEffort")}
}
