package codex

import (
	"path/filepath"
	"regexp"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "CODEX_HOME"

var fileStore = []string{"-c", `cli_auth_credentials_store="file"`}

func UserHome(env clisdk.Env, home string) string { return sh.CliHome(HomeEnv, ".codex", env, home) }

func launch(mode string, network *bool) ([]string, *util.Obj) {
	sandbox := "workspace-write"
	if mode == "plan" || mode == "manual" {
		sandbox = "read-only"
	} else if mode == "bypass" {
		sandbox = "danger-full-access"
	}
	args := []string{"-c", `sandbox_mode="` + sandbox + `"`}
	if sandbox == "workspace-write" && (network == nil || *network) {
		args = append(args, "-c", "sandbox_workspace_write.network_access=true")
	}
	if mode == "auto" {
		args = append(args, "-c", `approval_policy="on-request"`, "-c", `approvals_reviewer="auto_review"`)
	}
	return args, util.NewObj()
}

var Permissions = &clisdk.PermissionCapability{
	Supported:  sh.PermissionModes,
	Launch:     launch,
	FromModeID: sh.FromModeID(sh.PermissionModes, "auto"),
	PlanPrefix: sh.PlanPromptPrefix,
}

var Accounts = &clisdk.AccountCapability{
	HomeEnv: HomeEnv,
	Strip:   []string{"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME"},
	Shared: []clisdk.SharedEntry{
		{Name: "sessions", Dir: true, CreateIfMissing: true}, {Name: "archived_sessions", Dir: true},
		{Name: "config.toml"}, {Name: "skills", Dir: true}, {Name: "prompts", Dir: true}, {Name: "AGENTS.md"},
	},
	LoginArgs:   append([]string{"login", "--device-auth"}, fileStore...),
	LogoutArgs:  []string{"logout"},
	StatusArgs:  []string{"login", "status"},
	AccountArgs: fileStore,
}

var rolloutRe = regexp.MustCompile(`^rollout-.*\.jsonl(?:\.zst)?$`)

var History = &clisdk.HistoryCapability{
	Roots: sh.Roots1(UserHome, "sessions"),
	Scan: func(root string) []clisdk.HistoryFileRef {
		return sh.StatAll(sh.WalkFiles(root, 4, rolloutRe.MatchString, false))
	},
	Parse:  sh.HistoryParse("codex", ParseTranscript),
	Resume: func(id string) *util.Obj { return sh.Resume([]string{"resume", id}, true) },
}

func OfficialLaunch(ctx clisdk.LaunchContext) clisdk.AgentLaunch {
	args := []string{}
	if sh.Has(ctx.AccountDir) {
		args = append(args, fileStore...)
	}
	la, _ := launch(ctx.PermissionMode, nil)
	args = append(args, la...)
	if sh.Has(ctx.Model) {
		args = append(args, "-c", `model="`+*ctx.Model+`"`)
	}
	return clisdk.AgentLaunch{Env: sh.HomeEnvObj(ctx.AccountDir, HomeEnv), Args: args, Strip: sh.StripFor(Accounts.Strip, ctx.AccountDir, HomeEnv)}
}

var Exec = sh.UsageDone

var Slash = &clisdk.SlashDiscoveryCapability{Sources: func(projectChain []string, home string) []clisdk.SlashSource {
	out := []clisdk.SlashSource{}
	for _, dir := range projectChain {
		out = append(out, clisdk.SlashSource{Kind: "skills", Path: filepath.Join(dir, ".agents", "skills"), Scope: "project"})
	}
	return append(out, clisdk.SlashSource{Kind: "skills", Path: filepath.Join(home, ".agents", "skills"), Scope: "user"})
}}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Session:     &clisdk.SessionCustomization{Exec: Exec},
		Slash:       Slash,
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch, ModelArgs: sh.ModelArgsFn(ModelArgs)},
		Permissions: Permissions,
		Accounts:    Accounts,
		History:     History,
		Progress:    &clisdk.ProgressCapability{WatchRoots: sh.Roots1(UserHome, "sessions")},
		Usage:       &clisdk.UsageCapability{LogRoots: sh.Roots1(UserHome, "sessions")},
		Terminal:    sh.ResumeTerminal("codex", "resume"),
	}
}
