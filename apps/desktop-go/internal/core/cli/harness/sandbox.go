package harness

// sandbox.go：编程助手的系统级沙箱（internal/core/cli/sandbox）接到标签上：
// 起 CLI 时包进沙箱（关掉 CLI 自己的沙箱，Seatbelt 不能嵌套）、违规日志 → 标签上的授权请求、
// 用户授权（本会话 / 始终）后重启这个标签的 CLI 并接着做。见 docs/development/security.md「编程助手」。

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/sandbox"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/prompts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// SandboxGrant：一项授权（Kind：category / read / folder / file）。
// Project：只在这个项目（git 根或工作目录）里生效；空 = 所有项目（写入类授权都是全局的）
type SandboxGrant struct {
	Kind    string `json:"kind"`
	Value   string `json:"value"`
	Project string `json:"project,omitempty"`
}

// projectScoped：「始终允许」按项目记的授权（读凭据 / 密钥文件）；写入位置（工具缓存、钩子）是全局的
func projectScoped(kind string) bool { return kind == "category" || kind == "read" }

// projectRoot：工作目录所在的 git 仓库根（往上找 .git，到主目录为止）；不在仓库里就是工作目录本身
func (o *Orchestrator) projectRoot(cwd string) string {
	for d := filepath.Clean(cwd); ; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return d
		}
		if d == o.home || filepath.Dir(d) == d {
			return filepath.Clean(cwd)
		}
	}
}

func grantApplies(g SandboxGrant, cwd string) bool {
	if g.Project == "" {
		return true
	}
	rel, err := filepath.Rel(g.Project, cwd)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

// SandboxDeps：沙箱设置（宿主接 desktop.PermissionBroker）
type SandboxDeps struct {
	// Enabled：用户开着沙箱（默认开）
	Enabled func() bool
	// Protected：用户的受保护文件夹
	Protected func() []string
	// Always：「始终允许」的授权
	Always func() []SandboxGrant
	// Persist：记一条「始终允许」
	Persist func(g SandboxGrant)
}

// CLI 自己的主目录变量：值是这个 CLI 要写的地方（官方账号目录等）
var cliHomeEnvs = []string{"CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_CLI_HOME", "GROK_HOME", "DSH_HOME"}

// maxSandboxPending：一个标签同时挂着的授权请求上限
const maxSandboxPending = 5

type sbxPending struct {
	id   string
	req  sandbox.Request
	op   string
	path string
	at   float64
}

type tabSandbox struct {
	granted   map[string]bool
	dismissed map[string]bool
	pending   []*sbxPending
	// followUp：授权时这个标签正在跑，等这一轮结束后发「已允许，请继续」
	followUp string
}

type sbxState struct {
	tabs    map[string]*tabSandbox
	tokens  map[string]string
	seq     int
	monitor *sandbox.Monitor
}

func (o *Orchestrator) sbxTab(id string) *tabSandbox {
	if o.sbx.tabs == nil {
		o.sbx.tabs = map[string]*tabSandbox{}
	}
	t := o.sbx.tabs[id]
	if t == nil {
		t = &tabSandbox{granted: map[string]bool{}, dismissed: map[string]bool{}}
		o.sbx.tabs[id] = t
	}
	return t
}

// SandboxActive：起 CLI 时会不会包进沙箱
func (o *Orchestrator) SandboxActive() bool {
	return o.d.Sandbox != nil && o.d.Sandbox.Enabled != nil && o.d.Sandbox.Enabled() && sandbox.Supported()
}

// SandboxStatus：on / off / unsupported（界面显示）
func (o *Orchestrator) SandboxStatus() string {
	switch {
	case !sandbox.Supported():
		return "unsupported"
	case o.SandboxActive():
		return "on"
	}
	return "off"
}

// grantedFor：这个标签现在生效的授权：「始终允许」（按项目过滤）、任务预授权的类别、本会话的授权
func (o *Orchestrator) grantedFor(id string) []SandboxGrant {
	var out []SandboxGrant
	tab := o.tab(id)
	cwd := ""
	if tab != nil {
		cwd = str(tab, "cwd")
	}
	if o.d.Sandbox != nil && o.d.Sandbox.Always != nil {
		for _, g := range o.d.Sandbox.Always() {
			if grantApplies(g, cwd) {
				out = append(out, g)
			}
		}
	}
	if tab != nil {
		if d, _ := tab.Get("delegation").(*util.Obj); d != nil {
			if list, ok := d.Get("sandboxGrants").([]any); ok {
				for _, c := range list {
					if s, ok := c.(string); ok && sandbox.CategoryByID(s) != nil {
						out = append(out, SandboxGrant{Kind: "category", Value: s})
					}
				}
			}
		}
	}
	if t := o.sbx.tabs[id]; t != nil {
		for k := range t.granted {
			kind, value := splitKey(k)
			out = append(out, SandboxGrant{Kind: kind, Value: value})
		}
	}
	return out
}

func splitKey(k string) (string, string) {
	for i := 0; i < len(k); i++ {
		if k[i] == ':' {
			return k[:i], k[i+1:]
		}
	}
	return k, ""
}

func newToken() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// sandboxSpec：这一次启动的沙箱配置；不包（关着 / 不支持）时 nil
func (o *Orchestrator) sandboxSpec(tab *util.Obj, cwd string, env *util.Obj) *sandbox.Spec {
	if !o.SandboxActive() {
		return nil
	}
	id := str(tab, "id")
	token := newToken()
	if o.sbx.tokens == nil {
		o.sbx.tokens = map[string]string{}
	}
	o.sbx.tokens[token] = id
	spec := &sandbox.Spec{
		Token: token, Home: o.home, Cwd: cwd, CwdWritable: str(tab, "permissionMode") != "plan",
		NomiData:  filepath.Dir(o.d.Root),
		ReadAllow: []string{filepath.Join(o.d.Root, "prompt-images")},
		Granted:   map[string]bool{},
	}
	if o.d.Sandbox.Protected != nil {
		spec.Protected = o.d.Sandbox.Protected()
	}
	for _, k := range cliHomeEnvs {
		if v, ok := env.Get(k).(string); ok && filepath.IsAbs(v) {
			spec.Writable = append(spec.Writable, v)
		}
	}
	for _, g := range o.grantedFor(id) {
		switch g.Kind {
		case "category":
			spec.Granted[g.Value] = true
		case "read":
			spec.ReadFiles = append(spec.ReadFiles, g.Value)
		case "folder":
			spec.Writable = append(spec.Writable, g.Value)
		case "file":
			spec.WritableFiles = append(spec.WritableFiles, g.Value)
		}
	}
	return spec
}

// spawnCLI：起一个标签的 CLI 会话进程；沙箱开着时包进去（并关掉 CLI 自己的沙箱）
func (o *Orchestrator) spawnCLI(tab *util.Obj, command string, args []string, cwd string, env *util.Obj) clisdk.ChildLike {
	spec := o.sandboxSpec(tab, cwd, env)
	if spec != nil {
		env = env.Clone()
		switch str(tab, "backend") {
		case "gemini":
			env.Set("GEMINI_SANDBOX", "false")
		case "dsh":
			env.Set("DSH_PERMISSION_MODE", "danger-full-access")
		}
		o.ensureSandboxMonitor()
	}
	ch := spawnHarness(command, args, cwd, env, str(tab, "id"), spec)
	o.trackProc(str(tab, "id"), ch)
	return ch
}

// spawnHarness：SpawnHarness 加上可选的沙箱
func spawnHarness(command string, args []string, cwd string, env *util.Obj, tabID string, spec *sandbox.Spec) clisdk.ChildLike {
	l := cli.ResolveHarnessLaunch(command, args, env, usage.Platform(), nil)
	file, argv, verbatim := l.File, l.Args, l.Verbatim
	if spec != nil {
		file, argv = sandbox.Wrap(file, argv, sandbox.Profile(*spec))
		verbatim = false
	}
	ch := clisdk.ProcChild{Child: nodeproc.Spawn(file, argv, nodeproc.Options{Cwd: cwd, Env: usage.EnvSlice(l.Env), Verbatim: verbatim})}
	if CliTrap != nil {
		CliTrap(ch, command, args, tabID)
	}
	return ch
}

// claudeSandboxArgs：包进沙箱时关掉 Claude Code 自己的沙箱（嵌套会让它的 Bash 全部失败），并告诉它在沙箱里
func (o *Orchestrator) claudeSandboxArgs() []string {
	if !o.SandboxActive() {
		return nil
	}
	return []string{"--settings", `{"sandbox":{"enabled":false}}`, "--append-system-prompt", prompts.Text("cli-sandbox")}
}

// withSandboxNote：别的 CLI 没有附加系统提示的参数：CLI 会话的第一条消息前面带上沙箱说明
// （被拒时停下说明、等用户授权，不要绕路）
func (o *Orchestrator) withSandboxNote(tab *util.Obj, backend, toCli string) string {
	if backend == "claude" || !o.SandboxActive() || truthy(tab.Get("cliSessionId")) {
		return toCli
	}
	return prompts.Text("cli-sandbox") + "\n\n" + toCli
}

func (o *Orchestrator) ensureSandboxMonitor() {
	if o.sbx.monitor == nil {
		o.sbx.monitor = &sandbox.Monitor{OnDeny: func(d sandbox.Denial) {
			jsrt.Run(func() {
				if !o.disposed {
					o.onSandboxDeny(d)
				}
			})
		}}
	}
	o.sbx.monitor.Ensure()
}

func (o *Orchestrator) alwaysGranted(id string, r sandbox.Request) bool {
	for _, g := range o.grantedFor(id) {
		if g.Kind == r.Kind && g.Value == r.Value {
			return true
		}
	}
	return false
}

// onSandboxDeny：一条违规 → 标签上的授权请求（同一项只挂一次；授权过 / 拒绝过的不再问）
func (o *Orchestrator) onSandboxDeny(d sandbox.Denial) {
	id := o.sbx.tokens[d.Token]
	if id == "" || o.tab(id) == nil {
		return
	}
	req, ok := sandbox.Classify(d, o.home)
	if !ok {
		o.d.Logger.Info("cli sandbox blocked nomi data", util.NewObj("tab", id, "op", d.Op, "proc", d.Proc))
		return
	}
	t := o.sbxTab(id)
	key := req.Key()
	if t.granted[key] || t.dismissed[key] || o.alwaysGranted(id, req) {
		return
	}
	for _, p := range t.pending {
		if p.req.Key() == key {
			return
		}
	}
	if len(t.pending) >= maxSandboxPending {
		return
	}
	o.sbx.seq++
	op := "read"
	if len(d.Rule) >= 5 && d.Rule[:5] == "write" {
		op = "write"
	}
	t.pending = append(t.pending, &sbxPending{id: "sbx-" + strconv.Itoa(o.sbx.seq), req: req, op: op, path: d.Path, at: nowMs()})
	o.d.Logger.Info("cli sandbox blocked", util.NewObj("tab", id, "rule", d.Rule, "op", d.Op, "proc", d.Proc))
	o.changed()
	// 没人看着时（别的标签 / 窗口没在前台 / 委派与任务的标签）走「等权限」的通知：桌面角色气泡与系统通知
	tab := o.tab(id)
	o.events.Emit("permission-needed", util.NewObj("tabId", id, "title", tab.Get("title"), "backend", tab.Get("backend"),
		"summary", i18n.T("electron.common.sandbox-needs-permission", grantLabel(req)),
		"background", o.activeTabID != id || !o.appFocused()))
}

// sandboxPendingOf：标签状态里的待授权列表（不落盘）
func (o *Orchestrator) sandboxPendingOf(id string) []any {
	t := o.sbx.tabs[id]
	if t == nil || len(t.pending) == 0 {
		return nil
	}
	out := []any{}
	for _, p := range t.pending {
		out = append(out, util.NewObj("id", p.id, "kind", p.req.Kind, "value", p.req.Value, "op", p.op, "path", p.path, "at", p.at))
	}
	return out
}

// SandboxReply：回答一条授权请求。choice：session（本会话允许）/ always（始终允许）/ deny（不允许，本会话不再问）
func (o *Orchestrator) SandboxReply(tabID, requestID, choice string) bool {
	t := o.sbx.tabs[tabID]
	if t == nil {
		return false
	}
	var hit *sbxPending
	rest := t.pending[:0:0]
	for _, p := range t.pending {
		if p.id == requestID {
			hit = p
			continue
		}
		rest = append(rest, p)
	}
	if hit == nil {
		return false
	}
	key := hit.req.Key()
	switch choice {
	case "deny":
		t.dismissed[key] = true
	case "session", "always":
		if hit.req.Kind == "protected" {
			return false // 受保护的文件夹只能在设置里取消保护
		}
		t.granted[key] = true
		if choice == "always" && o.d.Sandbox != nil && o.d.Sandbox.Persist != nil {
			g := SandboxGrant{Kind: hit.req.Kind, Value: hit.req.Value}
			if projectScoped(g.Kind) {
				if tab := o.tab(tabID); tab != nil {
					g.Project = o.projectRoot(str(tab, "cwd"))
				}
			}
			o.d.Sandbox.Persist(g)
		}
		o.recycleTab(tabID)
		o.continueAfterGrant(tabID, hit.req)
	default:
		return false
	}
	t.pending = rest
	o.changed()
	return true
}

// recycleTab：这个标签的常驻 CLI 进程空闲时立刻关掉、在跑时这一轮结束后关掉；下一轮按新的沙箱配置重开（续接会话）
func (o *Orchestrator) recycleTab(id string) {
	if l := o.live.claude[id]; l != nil {
		if l.turn != nil && !l.turn.settled {
			l.recycleAfterTurn = true
		} else {
			o.teardownClaudeLive(id)
		}
	}
	if cl := o.live.codex[id]; cl != nil {
		if cl.turn != nil {
			cl.recycleAfterTurn = true
		} else {
			o.teardownCodexLive(id)
		}
	}
	if gl := o.live.acp[id]; gl != nil {
		if gl.turn != nil {
			gl.recycleAfterTurn = true
		} else {
			o.teardownAcpLive(id)
		}
	}
}

// SandboxPolicyChanged：沙箱开关、受保护文件夹、「始终允许」变了：所有常驻 CLI 按新配置重开
func (o *Orchestrator) SandboxPolicyChanged() {
	ids := map[string]bool{}
	for _, id := range o.live.claudeOrder {
		ids[id] = true
	}
	for _, id := range o.live.codexOrder {
		ids[id] = true
	}
	for _, id := range o.live.acpOrder {
		ids[id] = true
	}
	for id := range ids {
		o.recycleTab(id)
	}
	o.changed()
}

// sandboxCategoryKeys：类别 → 名称（写全 key，i18n 检查才认得出）
var sandboxCategoryKeys = map[string]string{
	"ssh":          "electron.common.sandbox-category-ssh",
	"cloud":        "electron.common.sandbox-category-cloud",
	"keys":         "electron.common.sandbox-category-keys",
	"browser":      "electron.common.sandbox-category-browser",
	"personal":     "electron.common.sandbox-category-personal",
	"secret-files": "electron.common.sandbox-category-secret-files",
}

func grantLabel(r sandbox.Request) string {
	if k := sandboxCategoryKeys[r.Value]; r.Kind == "category" && k != "" {
		return i18n.T(k)
	}
	return r.Value
}

// continueAfterGrant：授权后接着做——空闲就直接发「已允许，请继续」，在跑就等这一轮结束
func (o *Orchestrator) continueAfterGrant(id string, r sandbox.Request) {
	msg := i18n.T("electron.common.sandbox-granted-continue", grantLabel(r))
	tab := o.tab(id)
	if tab == nil {
		return
	}
	if s := str(tab, "status"); s == "running" || s == "queued" {
		o.sbxTab(id).followUp = msg
		return
	}
	o.sendFollowUp(id, msg)
}

func (o *Orchestrator) sendFollowUp(id, msg string) {
	if o.nextOrigin == nil {
		o.nextOrigin = map[string]string{}
	}
	o.nextOrigin[id] = "sandbox"
	p := o.SendTab(id, msg, nil, false)
	jsrt.Async(func() (struct{}, error) {
		if _, err := jsrt.Await(p); err != nil {
			o.d.Logger.Warn("harness sandbox follow-up failed", err)
		}
		return struct{}{}, nil
	})
}

// afterTurnSandbox：一轮结束（SendTab 收尾）时补发授权后的「请继续」
func (o *Orchestrator) afterTurnSandbox(id string) {
	t := o.sbx.tabs[id]
	if t == nil || t.followUp == "" {
		return
	}
	msg := t.followUp
	t.followUp = ""
	jsrt.Go(func() {
		if o.disposed || o.tab(id) == nil {
			return
		}
		o.sendFollowUp(id, msg)
	})
}

// forgetSandbox：关标签时清掉它的授权与启动标记
func (o *Orchestrator) forgetSandbox(id string) {
	delete(o.sbx.tabs, id)
	for tok, tab := range o.sbx.tokens {
		if tab == id {
			delete(o.sbx.tokens, tok)
		}
	}
}

func (o *Orchestrator) disposeSandbox() {
	if o.sbx.monitor != nil {
		o.sbx.monitor.Stop()
	}
}

// sandboxGrantList：委派 / 任务带来的预授权类别（只留认得的类别 id）
func sandboxGrantList(v any) []any {
	out := []any{}
	switch list := v.(type) {
	case []any:
		for _, x := range list {
			if s, ok := x.(string); ok && sandbox.CategoryByID(s) != nil {
				out = append(out, s)
			}
		}
	case []string:
		for _, s := range list {
			if sandbox.CategoryByID(s) != nil {
				out = append(out, s)
			}
		}
	}
	return out
}
