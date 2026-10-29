package grok

import (
	"path/filepath"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "GROK_HOME"

var Modes = []string{"plan", "manual", "acceptEdits", "bypass"}

func ModeID(mode string) string {
	if mode == "manual" || mode == "auto" {
		return "default"
	}
	return sh.ClaudeMode[mode]
}

func ModeArgs(mode string) []string {
	if mode == "bypass" {
		return []string{"--yolo"}
	}
	return []string{"--permission-mode", sh.ClaudeMode[mode]}
}

func UserHome(env clisdk.Env, home string) string { return sh.CliHome(HomeEnv, ".grok", env, home) }

var Permissions = &clisdk.PermissionCapability{
	Supported:  Modes,
	Launch:     func(mode string, _ *bool) ([]string, *util.Obj) { return ModeArgs(mode), util.NewObj() },
	ModeID:     ModeID,
	FromModeID: sh.FromModeID(Modes, ""),
}

var Accounts = &clisdk.AccountCapability{
	HomeEnv: HomeEnv,
	Strip:   []string{"XAI_API_KEY", "GROK_API_KEY", "GROK_HOME"},
	Shared: []clisdk.SharedEntry{
		{Name: "sessions", Dir: true, CreateIfMissing: true}, {Name: "config.toml"}, {Name: "installed-plugins", Dir: true},
		{Name: "memory-v2", Dir: true}, {Name: "bin", Dir: true}, {Name: "bundled", Dir: true},
	},
	LoginArgs:  []string{"login", "--device-auth"},
	LogoutArgs: []string{"logout"},
}

var History = &clisdk.HistoryCapability{
	Roots: sh.Roots1(UserHome, "sessions"),
	Scan: func(root string) []clisdk.HistoryFileRef {
		return sh.StatAll(sh.WalkFiles(root, 4, func(n string) bool { return n == "updates.jsonl" }, true))
	},
	Parse:  sh.HistoryParse("grok", ParseTranscript),
	Resume: func(id string) *util.Obj { return sh.Resume([]string{"--resume", id}, true) },
}

func OfficialLaunch(ctx clisdk.LaunchContext) clisdk.AgentLaunch {
	args := ModeArgs(ctx.PermissionMode)
	if sh.Has(ctx.Model) {
		args = append(args, "-m", *ctx.Model)
	}
	return clisdk.AgentLaunch{Env: sh.HomeEnvObj(ctx.AccountDir, HomeEnv), Args: args, Strip: sh.StripFor(Accounts.Strip, ctx.AccountDir, HomeEnv)}
}

var Exec = sh.UsageDone

var Slash = &clisdk.SlashDiscoveryCapability{Sources: func(projectChain []string, home string) []clisdk.SlashSource {
	t := true
	at := func(base, scope string) []clisdk.SlashSource {
		return []clisdk.SlashSource{
			{Kind: "skills", Path: filepath.Join(base, "skills"), Scope: scope, StrictInvocable: &t},
			{Kind: "commands", Path: filepath.Join(base, "commands"), Scope: scope},
			{Kind: "plugins", Path: filepath.Join(base, "plugins"), Scope: scope},
			{Kind: "workflows", Path: filepath.Join(base, "workflows"), Scope: scope},
		}
	}
	bundled := filepath.Join(home, ".grok", "bundled")
	out := []clisdk.SlashSource{}
	for _, dir := range projectChain {
		out = append(out, at(filepath.Join(dir, ".grok"), "project")...)
	}
	out = append(out, at(filepath.Join(home, ".grok"), "user")...)
	return append(out,
		clisdk.SlashSource{Kind: "skills", Path: filepath.Join(bundled, "skills"), Scope: "bundled", StrictInvocable: &t},
		clisdk.SlashSource{Kind: "workflows", Path: filepath.Join(bundled, "workflows"), Scope: "bundled"})
}}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Session:     &clisdk.SessionCustomization{Exec: Exec},
		Slash:       Slash,
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch, PlaceholderModel: "nomi", ModelArgs: sh.ModelArgsFn(ModelArgs)},
		Permissions: Permissions,
		Accounts:    Accounts,
		History:     History,
		Progress:    &clisdk.ProgressCapability{WatchRoots: sh.Roots1(UserHome, "sessions")},
		Usage:       &clisdk.UsageCapability{LogRoots: sh.Roots1(UserHome, "sessions")},
		Terminal:    sh.ResumeTerminal("grok", "--resume"),
	}
}
