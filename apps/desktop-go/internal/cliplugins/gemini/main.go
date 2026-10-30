package gemini

import (
	"path/filepath"
	"regexp"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "GEMINI_CLI_HOME"

var Modes = []string{"plan", "manual", "acceptEdits", "bypass"}

func ModeID(mode string) string {
	switch mode {
	case "plan":
		return "plan"
	case "acceptEdits", "auto":
		return "autoEdit"
	case "bypass":
		return "yolo"
	}
	return "default"
}

func UserHome(env clisdk.Env, home string) string { return sh.GeminiRoot(env, home) }

var Permissions = &clisdk.PermissionCapability{
	Supported:  Modes,
	Launch:     func(string, *bool) ([]string, *util.Obj) { return []string{}, util.NewObj() },
	ModeID:     ModeID,
	FromModeID: sh.FromModeID(Modes, ""),
}

var Accounts = &clisdk.AccountCapability{
	HomeEnv: HomeEnv,
	Strip: []string{"GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI",
		"GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_CLI_HOME", "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", "GEMINI_FORCE_ENCRYPTED_FILE"},
	Shared: []clisdk.SharedEntry{
		{Name: ".gemini/tmp", Dir: true, CreateIfMissing: true}, {Name: ".gemini/settings.json"}, {Name: ".gemini/GEMINI.md"},
		{Name: ".gemini/commands", Dir: true}, {Name: ".gemini/extensions", Dir: true}, {Name: ".gemini/trustedFolders.json"},
		{Name: ".gemini/projects.json"},
	},
	LoginArgs: []string{"--acp"},
}

var sessRe = regexp.MustCompile(`^session-.*\.jsonl?$`)

var History = &clisdk.HistoryCapability{
	Roots: sh.Roots1(UserHome, ".gemini", "tmp"),
	Scan: func(root string) []clisdk.HistoryFileRef {
		files := []sh.FileCand{}
		for _, proj := range sh.Readdir(root) {
			if !sh.IsDirentDir(proj) {
				continue
			}
			chats := filepath.Join(root, proj.Name(), "chats")
			for _, f := range sh.Readdir(chats) {
				if sh.IsDirentFile(f) && sessRe.MatchString(f.Name()) {
					files = append(files, sh.FileCand{Path: filepath.Join(chats, f.Name())})
				}
			}
		}
		return sh.StatAll(files)
	},
	Parse:  sh.HistoryParse("gemini", ParseTranscript),
	Resume: func(id string) *util.Obj { return sh.Resume([]string{"--resume", id}, true) },
}

func OfficialLaunch(ctx clisdk.LaunchContext) clisdk.AgentLaunch {
	args := []string{}
	if sh.Has(ctx.Model) {
		args = []string{"-m", *ctx.Model}
	}
	return clisdk.AgentLaunch{Env: sh.HomeEnvObj(ctx.AccountDir, HomeEnv), Args: args, Strip: sh.StripFor(Accounts.Strip, ctx.AccountDir, HomeEnv)}
}

var Exec = sh.UsageDone

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Session:     &clisdk.SessionCustomization{Exec: Exec},
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch},
		Permissions: Permissions,
		Accounts:    Accounts,
		History:     History,
		Progress:    &clisdk.ProgressCapability{WatchRoots: sh.Roots1(UserHome, ".gemini", "tmp")},
		Terminal:    sh.ResumeTerminal("gemini", "--resume"),
	}
}
