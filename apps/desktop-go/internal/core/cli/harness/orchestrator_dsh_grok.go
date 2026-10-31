package harness

// Node Orchestrator.ts 4463–4683：dsh / grok -p / spawnCollect（每轮一个进程）。
// b7 的占位文件名为 orchestrator_exec.go，按任务改名（D-B7-O-4）。

import (
	"errors"
	"path/filepath"
	"strings"

	claudep "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	codexp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	dshp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	geminip "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	grokp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// execRules = EXEC_RULES（插件的 execRules）。
var execRules = map[string]*clisdk.ExecRules{
	"claude": claudep.Exec, "codex": codexp.Exec, "dsh": dshp.Exec, "gemini": geminip.Exec, "grok": grokp.Exec,
}

// collectOpts = spawnCollect 的 opts。
type collectOpts struct {
	cmd       string
	argv      []string
	parseLine func(line string) []clisdk.Ev
	kind      string
	env       *util.Obj
	launch    *tabLaunch
	asNode    bool
	keepStdin bool
}

func leadSpace(p string) string {
	if strings.HasPrefix(p, "-") {
		return " " + p
	}
	return p
}

func (o *Orchestrator) runDsh(tab *util.Obj, prompt string) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		bin := ResolveHarnessBin("dsh")
		if bin == "" {
			return nil, errors.New(i18n.T("electron.common.dsh-not-found-set-nomi-use-mock-cli"))
		}
		useNode := IsScript(bin)
		launch := o.launchFor(tab)
		argv := append(append([]string{"--profile", "headless"}, launch.args...), "--json")
		if sid, ok := tab.Get("cliSessionId").(string); ok && sid != "" {
			argv = append(argv, "--session-id", sid)
		}
		if tab.Get("permissionMode") == "plan" {
			p, _ := cli.PlanPromptPrefix("dsh")
			prompt = p + prompt
		}
		argv = append(argv, leadSpace(prompt))
		cmd, args := bin, argv
		if useNode {
			cmd, args = nodeExecPath(), append([]string{bin}, argv...)
		}
		return jsrt.Await(o.spawnCollect(tab, collectOpts{
			cmd: cmd, argv: args, parseLine: dshp.NewParser(), kind: "dsh",
			env:    cli.PermissionLaunchFor("dsh", str(tab, "permissionMode"), nil).Env,
			launch: launch, asNode: useNode,
		}))
	})
}

func (o *Orchestrator) runGrokTurn(tab *util.Obj, prompt string, signal *jsrt.AbortSignal, images []cli.NormalizedImage) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		if o.d.GrokAcp && !o.live.grokAcpUnavailable {
			r, err := jsrt.Await(o.runAcp(tab, prompt, signal, images))
			if err == nil {
				return r, nil
			}
			ua, ok := err.(*acpUnavailableError)
			if !ok || ua == nil || signal.Aborted() {
				return nil, err
			}
			o.live.grokAcpUnavailable = true
			o.d.Logger.Warn("harness grok ACP unavailable, falling back to grok -p", err)
		}
		return jsrt.Await(o.runGrok(tab, prompt, images))
	})
}

// promptImageDir（Node 4515）。
func (o *Orchestrator) promptImageDir(tabID string) string {
	return filepath.Join(o.d.Root, "prompt-images", nonWordDash.ReplaceAllString(tabID, "_"))
}

func (o *Orchestrator) runGrok(tab *util.Obj, prompt string, images []cli.NormalizedImage) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		bin := ResolveHarnessBin("grok")
		if bin == "" {
			return nil, errors.New(i18n.T("electron.common.grok-not-found-set-nomi-use-mock-cli"))
		}
		useNode := IsScript(bin)
		launch := o.launchFor(tab)
		var argv []string
		if len(images) > 0 {
			a, err := cli.GrokPromptFileArgv(o.promptImageDir(str(tab, "id")), prompt, images)
			if err != nil {
				return nil, err
			}
			argv = a
		} else {
			argv = []string{"-p", leadSpace(prompt)}
		}
		argv = append(argv, "--output-format", "streaming-json", "--no-auto-update")
		argv = append(argv, cli.PermissionLaunchFor("grok", str(tab, "permissionMode"), nil).Args...)
		if !launch.modelInConfig {
			ov := o.effectiveOverrides(tab)
			argv = append(argv, cli.OverrideArgs("grok", ov.model, ptrAny(ov.effort))...)
		}
		if sid, ok := tab.Get("cliSessionId").(string); ok && sid != "" {
			argv = append(argv, "--resume", sid)
		}
		if cwd := str(tab, "cwd"); cwd != "" {
			argv = append(argv, "--cwd", cwd)
		}
		cmd, args := bin, argv
		if useNode {
			cmd, args = nodeExecPath(), append([]string{bin}, argv...)
		}
		return jsrt.Await(o.spawnCollect(tab, collectOpts{cmd: cmd, argv: args, parseLine: grokp.NewParser(), kind: "grok", launch: launch, asNode: useNode}))
	})
}

func (o *Orchestrator) spawnCollect(tab *util.Obj, opts collectOpts) *jsrt.Promise[*util.Obj] {
	return jsrt.Async(func() (*util.Obj, error) {
		id := str(tab, "id")
		events := []*util.Obj{}
		text := ""
		breaks := []float64{}
		var sessionID any
		if s, ok := tab.Get("cliSessionId").(string); ok {
			sessionID = s
		}
		chatRoot := filepath.Join(filepath.Dir(o.d.Root), "chat")
		imageAliases := LoadImageAliases(chatRoot)
		rules := execRules[opts.kind]
		base := opts.launch
		if base == nil {
			base = officialLaunch
		}
		launch, err := jsrt.Await(o.bindTabLaunch(tab, base))
		if err != nil {
			return nil, err
		}
		var resume *string
		if s, ok := tab.Get("cliSessionId").(string); ok {
			resume = &s
		}
		aborted := i18n.T("electron.common.aborted")
		do := drivers.ExecDriverOptions{
			Spawn: func(cmd string, argv []string, cwd string) clisdk.ChildLike {
				child := SpawnHarness(cmd, argv, cwd, o.childEnv(opts.asNode, launch, opts.env), id)
				o.watchTabRelease(tab, child)
				o.children.Set(id, child)
				return child
			},
			Command:        opts.cmd,
			Cwd:            str(tab, "cwd"),
			Args:           func(clisdk.TurnInput, *string) []string { return opts.argv },
			Parser:         func() func(string) []clisdk.Ev { return opts.parseLine },
			ResumeID:       resume,
			KeepStdin:      opts.keepStdin,
			Completes:      rules.Completes,
			StopRequested:  func() bool { return o.stopRequested[id] },
			AbortedMessage: &aborted,
			ExitMessage:    func(code *int) string { return i18n.T("electron.common.exit-code", opts.kind, intOrNull(code)) },
			OnStderr:       func(c string) { o.d.Logger.Warn("harness "+opts.kind+" stderr", clisdk.Slice0(c, 500)) },
		}
		if rules.SilentExitIsError {
			do.SilentExit = func() *string {
				v := cli.ReadPathNodeVersion()
				var va any = v
				if v == "" {
					va = i18n.T("electron.common.not-found")
				}
				s := i18n.T("electron.common.dsh-produced-no-output-it-needs-node-the", cli.DshMinNodeMajor, va)
				return &s
			}
		}
		driver := drivers.NewExecDriver(do)
		take := func(rawEv *util.Obj, live bool) {
			ev := rawEv
			if ev.Get("type") == "tool" && truthy(ev.Get("output")) {
				MaterializeGeneratedImages(jsStr(ev.Get("output")), o.home, chatRoot, imageAliases)
				text = RewriteGeneratedImageLinks(text, imageAliases)
			}
			if t := ev.Get("type"); t == "text-delta" || t == "text" || t == "done" {
				old := jsStr(ev.Get("text"))
				if nt := RewriteGeneratedImageLinks(old, imageAliases); nt != old {
					ev = ev.Clone()
					ev.Set("text", nt)
				}
			}
			ev = WithPermissionExpiry(clisdk.StampEvent(ev, nowMs()), o.PermissionTimeoutMs(id))
			text, breaks, ev = cli.FoldAssistantEvent(text, breaks, ev)
			if ev.Get("type") != "text-delta" {
				events = append(events, ev)
			}
			if ev.Get("type") == "permission" {
				ev = MarkApprovePlanIfExit(ev)
			}
			if live {
				o.emitEvent(id, ev)
			}
			if ev.Get("type") == "permission" {
				o.armPermissionTimeout(id, jsStr(ev.Get("id")))
				pev := ev
				notify := func() {
					o.events.Emit("permission-needed", util.NewObj(
						"tabId", id, "title", tab.Get("title"), "backend", tab.Get("backend"), "summary", pev.Get("summary"),
						"background", o.activeTabID != id || !o.appFocused()))
				}
				if pev.Get("kind") == "approve-plan" {
					notify()
				} else {
					o.allowIfBypass(id, jsStr(pev.Get("id")), notify)
				}
			}
			if ev.Get("type") == "done" && truthy(ev.Get("sessionId")) {
				sessionID = ev.Get("sessionId")
			}
		}
		driver.On(func(se clisdk.SessionEvent) {
			if se.Get("kind") == "harness" {
				take(util.AsObj(se.Get("event")), !truthy(se.Get("tail")))
			}
		})
		_, sendErr := jsrt.Await(driver.Send(clisdk.TurnInput{Text: ""}))
		o.children.Delete(id)
		o.clearPermissionTimeouts(id)
		driver.Close()
		if sendErr != nil {
			return nil, sendErr
		}
		out := RewriteGeneratedImageLinks(text, imageAliases)
		if out == "" {
			out = i18n.T("electron.common.no-text-output")
		}
		res := util.NewObj("text", out, "sessionId", sessionID, "events", evsAny(events))
		if len(breaks) > 0 {
			res.Set("textBreaks", breaksAny(breaks))
		}
		return res, nil
	})
}

// intOrNull：模板里 code 为 null 时 Node 插值为 "null"。
func intOrNull(c *int) any {
	if c == nil {
		return nil
	}
	return float64(*c)
}
