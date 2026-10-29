package cliplugins_test

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func sp(s string) *string { return &s }

func strs(l []string) any {
	if l == nil {
		return nil
	}
	return sh.StrsAny(l)
}

func launchOut(l clisdk.AgentLaunch) any {
	return util.NewObj("env", l.Env, "args", sh.StrsAny(l.Args), "strip", sh.StrsAny(l.Strip))
}

func sources(l []clisdk.SlashSource) any {
	out := []any{}
	for _, s := range l {
		o := util.NewObj("kind", s.Kind, "path", s.Path, "scope", s.Scope)
		if s.StrictInvocable != nil {
			o.Set("strictInvocable", *s.StrictInvocable)
		}
		out = append(out, o)
	}
	return out
}

func cmdOut(c clisdk.Command) any {
	return util.NewObj("command", c.Command, "args", sh.StrsAny(c.Args))
}

func envOf(o *util.Obj) clisdk.Env {
	e := clisdk.Env{}
	for _, k := range o.Keys() {
		e[k] = o.Get(k).(string)
	}
	return e
}

func pluginSnapshot(a []any) any {
	id := a[0].(string)
	m, _ := builtin.Plugins[id].Main(clisdk.CliMainHost{})
	p := m.Permissions
	modes := []string{"plan", "manual", "acceptEdits", "auto", "bypass"}
	native := []string{"plan", " auto ", "default", "Read_Only", "on request", "on-request", "workspace write", "YOLO",
		"danger", "dontAsk", "bypassPermissions", "weird", "", "  "}
	f := false
	launch := []any{}
	for _, x := range modes {
		a1, e1 := p.Launch(x, nil)
		a2, e2 := p.Launch(x, &f)
		launch = append(launch, []any{util.NewObj("args", sh.StrsAny(a1), "env", e1), util.NewObj("args", sh.StrsAny(a2), "env", e2)})
	}
	var modeID any
	if p.ModeID != nil {
		l := []any{}
		for _, x := range modes {
			l = append(l, p.ModeID(x))
		}
		modeID = l
	}
	from := []any{}
	for _, x := range native {
		if r := p.FromModeID(x); r != "" {
			from = append(from, r)
		} else {
			from = append(from, nil)
		}
	}
	var planPrefix any
	if p.PlanPrefix != "" {
		planPrefix = p.PlanPrefix
	}
	ctxs := []clisdk.LaunchContext{
		{Cwd: "/w", PermissionMode: "manual", RunDir: "/r"},
		{Cwd: "/w", PermissionMode: "bypass", Model: sp("m-1"), Effort: sp("high"), AccountDir: sp("/acct"), RunDir: "/r"},
		{Cwd: "/w", PermissionMode: "auto", Model: sp(""), AccountDir: sp(""), RunDir: "/r"},
		{Cwd: "/w", PermissionMode: "plan", Model: sp(`x"y`), AccountDir: sp("/a b"), RunDir: "/r"},
		{Cwd: "/w", PermissionMode: "acceptEdits", RunDir: "/r"},
	}
	official := []any{}
	for _, c := range ctxs {
		official = append(official, launchOut(m.Launch.Official(c)))
	}
	var placeholder any
	if m.Launch.PlaceholderModel != "" {
		placeholder = m.Launch.PlaceholderModel
	}
	var modelArgs any
	if m.Launch.ModelArgs != nil {
		mas := []clisdk.ModelArgsOpts{{}, {Model: sp(" m "), Effort: sp("low")}, {Model: sp("")}, {Model: sp(`a"\b`)}}
		l := []any{}
		for _, o := range mas {
			l = append(l, sh.StrsAny(m.Launch.ModelArgs(o)))
		}
		modelArgs = l
	}
	var accounts any
	if ac := m.Accounts; ac != nil {
		shared := []any{}
		for _, s := range ac.Shared {
			o := util.NewObj("name", s.Name, "dir", s.Dir)
			if s.CreateIfMissing {
				o.Set("createIfMissing", true)
			}
			shared = append(shared, o)
		}
		o := util.NewObj("homeEnv", ac.HomeEnv, "strip", sh.StrsAny(ac.Strip), "shared", shared, "loginArgs", sh.StrsAny(ac.LoginArgs))
		for _, kv := range []struct {
			k string
			v []string
		}{{"logoutArgs", ac.LogoutArgs}, {"statusArgs", ac.StatusArgs}, {"accountArgs", ac.AccountArgs}} {
			if kv.v != nil {
				o.Set(kv.k, sh.StrsAny(kv.v))
			}
		}
		accounts = o
	}
	envs := []clisdk.Env{{}, envOf(util.NewObj("CLAUDE_CONFIG_DIR", "~/cc", "CODEX_HOME", " /abs/codex ", "GROK_HOME", "~", "DSH_HOME", `~\d`, "GEMINI_CLI_HOME", "/g"))}
	rootsOf := func(fn func(clisdk.Env, string) []string) any {
		l := []any{}
		for _, e := range envs {
			l = append(l, sh.StrsAny(fn(e, "/home/u")))
		}
		return l
	}
	var logRoots any
	if m.Usage != nil && m.Usage.LogRoots != nil {
		logRoots = rootsOf(m.Usage.LogRoots)
	}
	var slash any
	if m.Slash != nil && m.Slash.Sources != nil {
		slash = []any{sources(m.Slash.Sources([]string{}, "/h")), sources(m.Slash.Sources([]string{"/p/a", "/p"}, "/h"))}
	}
	var term any
	if m.Terminal != nil {
		tc := m.Terminal.Command
		term = []any{cmdOut(tc("/w", nil, util.NewObj())), cmdOut(tc("/w", sp("r1"), util.NewObj())), cmdOut(tc("/w", sp(""), util.NewObj()))}
	}
	evs := []*util.Obj{util.NewObj("type", "done"), util.NewObj("type", "done", "usage", util.NewObj()), util.NewObj("type", "done", "sessionId", "s"),
		util.NewObj("type", "done", "sessionId", "s", "usage", util.NewObj("a", 1.0)), util.NewObj("type", "text")}
	comp := []any{}
	for _, e := range evs {
		comp = append(comp, m.Session.Exec.Completes(e))
	}
	var silent any
	if m.Session.Exec.SilentExitIsError {
		silent = true
	}
	return util.NewObj(
		"supported", sh.StrsAny(p.Supported), "launch", launch, "modeId", modeID, "fromModeId", from, "planPrefix", planPrefix,
		"official", official, "placeholderModel", placeholder, "modelArgs", modelArgs, "accounts", accounts,
		"roots", rootsOf(m.History.Roots), "resume", m.History.Resume("sid"), "watch", rootsOf(m.Progress.WatchRoots),
		"logRoots", logRoots, "slash", slash, "terminal", term,
		"exec", util.NewObj("completes", comp, "silentExitIsError", silent))
}

func terminalLine(a []any) any {
	o := a[0].(*util.Obj)
	args := []string{}
	for _, x := range o.Get("args").([]any) {
		args = append(args, x.(string))
	}
	env := []sh.KV{}
	eo := o.Get("env").(*util.Obj)
	for _, k := range eo.Keys() {
		env = append(env, sh.KV{K: k, V: eo.Get(k).(string)})
	}
	return sh.TerminalLine(o.Get("command").(string), args, env, a[1].(string))
}

func init() {
	fnRegistry["pluginSnapshot"] = pluginSnapshot
	fnRegistry["terminalLine"] = terminalLine
}
