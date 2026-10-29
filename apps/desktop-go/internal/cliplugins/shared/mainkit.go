package shared

import (
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// UsageDone mirrors USAGE_DONE。
var UsageDone = &clisdk.ExecRules{Completes: func(ev clisdk.Ev) bool {
	return ev.Get("type") == "done" && util.Truthy(ev.Get("usage"))
}}

// StripFor mirrors accounts.strip.filter((k) => ctx.accountDir || k !== HOME_ENV)。
func StripFor(strip []string, accountDir *string, homeEnv string) []string {
	out := []string{}
	for _, k := range strip {
		if (accountDir != nil && *accountDir != "") || k != homeEnv {
			out = append(out, k)
		}
	}
	return out
}

// HomeEnvObj：ctx.accountDir ? { [HOME_ENV]: dir, ...extra } : {}。
func HomeEnvObj(accountDir *string, homeEnv string, extra ...any) *util.Obj {
	if accountDir == nil || *accountDir == "" {
		return util.NewObj()
	}
	return util.NewObj(append([]any{homeEnv, *accountDir}, extra...)...)
}

// Truthy *string（ctx.model 等）。
func Has(p *string) bool { return p != nil && *p != "" }

// Roots1 → (env, home) => [path.join(userHome(env, home), parts...)]。
func Roots1(userHome func(clisdk.Env, string) string, parts ...string) func(clisdk.Env, string) []string {
	return func(env clisdk.Env, home string) []string {
		return []string{filepath.Join(append([]string{userHome(env, home)}, parts...)...)}
	}
}

// Resume 构造 {args, loadSession?}。
func Resume(args []string, load bool) *util.Obj {
	o := util.NewObj("args", StrsAny(args))
	if load {
		o.Set("loadSession", true)
	}
	return o
}

// ResumeTerminal：command(o) => ({command, args: o.resumeId ? [flag..., id] : []})。
func ResumeTerminal(cmd string, flag string) *clisdk.TerminalCapability {
	return &clisdk.TerminalCapability{Command: func(_ string, resumeID *string, _ *util.Obj) clisdk.Command {
		if Has(resumeID) {
			return clisdk.Command{Command: cmd, Args: []string{flag, *resumeID}}
		}
		return clisdk.Command{Command: cmd, Args: []string{}}
	}}
}

// ModelArgsFn 把 ModelArgsIn 形状接到 clisdk.ModelArgsOpts。
func ModelArgsFn(f func(ModelArgsIn) []string) func(clisdk.ModelArgsOpts) []string {
	return func(o clisdk.ModelArgsOpts) []string {
		in := ModelArgsIn{}
		if o.Model != nil {
			in.Model = *o.Model
		}
		if o.Effort != nil {
			in.Effort = *o.Effort
		}
		return f(in)
	}
}

// FromModeID 绑定 modeFromNative。
func FromModeID(supported []string, onRequest string) func(string) string {
	return func(id string) string { return ModeFromNative(supported, id, onRequest) }
}
