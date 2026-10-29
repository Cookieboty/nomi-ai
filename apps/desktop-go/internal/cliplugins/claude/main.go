package claude

import (
	"path/filepath"
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "CLAUDE_CONFIG_DIR"

func UserHome(env clisdk.Env, home string) string { return sh.CliHome(HomeEnv, ".claude", env, home) }

var Permissions = &clisdk.PermissionCapability{
	Supported: sh.PermissionModes,
	Launch: func(mode string, _ *bool) ([]string, *util.Obj) {
		return []string{"--permission-mode", sh.ClaudeMode[mode]}, util.NewObj()
	},
	ModeID:     func(mode string) string { return sh.ClaudeMode[mode] },
	FromModeID: sh.FromModeID(sh.PermissionModes, ""),
}

var Accounts = &clisdk.AccountCapability{
	HomeEnv: HomeEnv,
	Strip: []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "ANTHROPIC_PROFILE", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CONFIG_DIR"},
	Shared: []clisdk.SharedEntry{
		{Name: "projects", Dir: true, CreateIfMissing: true}, {Name: "history.jsonl"}, {Name: "CLAUDE.md"},
		{Name: "keybindings.json"}, {Name: "skills", Dir: true}, {Name: "commands", Dir: true}, {Name: "agents", Dir: true},
		{Name: "rules", Dir: true}, {Name: "output-styles", Dir: true}, {Name: "todos", Dir: true},
	},
	LoginArgs:  []string{"auth", "login", "--claudeai"},
	LogoutArgs: []string{"auth", "logout"},
	StatusArgs: []string{"auth", "status", "--json"},
}

var History = &clisdk.HistoryCapability{
	Roots: sh.Roots1(UserHome, "projects"),
	Scan: func(root string) []clisdk.HistoryFileRef {
		files := []sh.FileCand{}
		for _, dir := range sh.Readdir(root) {
			if !sh.IsDirentDir(dir) {
				continue
			}
			for _, f := range sh.Readdir(filepath.Join(root, dir.Name())) {
				if sh.IsDirentFile(f) && strings.HasSuffix(f.Name(), ".jsonl") {
					files = append(files, sh.FileCand{Path: filepath.Join(root, dir.Name(), f.Name())})
				}
			}
		}
		return sh.StatAll(files)
	},
	Parse:  sh.HistoryParse("claude", ParseTranscript),
	Resume: func(id string) *util.Obj { return sh.Resume([]string{"--resume", id}, false) },
}

func OfficialLaunch(ctx clisdk.LaunchContext) clisdk.AgentLaunch {
	args, _ := Permissions.Launch(ctx.PermissionMode, nil)
	if sh.Has(ctx.Model) {
		args = append(args, "--model", *ctx.Model)
	}
	return clisdk.AgentLaunch{
		Env:   sh.HomeEnvObj(ctx.AccountDir, HomeEnv, "CLAUDE_CODE_DISABLE_AGENT_VIEW", "1"),
		Args:  args,
		Strip: sh.StripFor(Accounts.Strip, ctx.AccountDir, HomeEnv),
	}
}

var Exec = sh.UsageDone

var Slash = &clisdk.SlashDiscoveryCapability{Sources: func(projectChain []string, home string) []clisdk.SlashSource {
	out := []clisdk.SlashSource{}
	for _, dir := range projectChain {
		out = append(out,
			clisdk.SlashSource{Kind: "skills", Path: filepath.Join(dir, ".claude", "skills"), Scope: "project"},
			clisdk.SlashSource{Kind: "commands", Path: filepath.Join(dir, ".claude", "commands"), Scope: "project"},
			clisdk.SlashSource{Kind: "agents", Path: filepath.Join(dir, ".claude", "agents"), Scope: "project"},
			clisdk.SlashSource{Kind: "mcp", Path: filepath.Join(dir, ".mcp.json"), Scope: "project"})
	}
	return append(out,
		clisdk.SlashSource{Kind: "skills", Path: filepath.Join(home, ".claude", "skills"), Scope: "user"},
		clisdk.SlashSource{Kind: "commands", Path: filepath.Join(home, ".claude", "commands"), Scope: "user"},
		clisdk.SlashSource{Kind: "agents", Path: filepath.Join(home, ".claude", "agents"), Scope: "user"})
}}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Session:     &clisdk.SessionCustomization{Exec: Exec},
		Slash:       Slash,
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch, ModelArgs: sh.ModelArgsFn(ModelArgs)},
		Permissions: Permissions,
		Accounts:    Accounts,
		History:     History,
		Progress:    &clisdk.ProgressCapability{WatchRoots: sh.Roots1(UserHome, "projects")},
		Usage:       &clisdk.UsageCapability{LogRoots: sh.Roots1(UserHome, "projects")},
		Terminal:    sh.ResumeTerminal("claude", "--resume"),
	}
}
