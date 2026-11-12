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

// OfficialLaunch：本机配置（~/.gemini 里用户自己配的 API Key / Vertex / 企业版授权）。
// 没有 Nomi 管理的官方账号：Google 已不再让 Gemini CLI 用个人 Google 账号登录（Code Assist for individuals）
func OfficialLaunch(ctx clisdk.LaunchContext) clisdk.AgentLaunch {
	args := []string{}
	if sh.Has(ctx.Model) {
		args = []string{"-m", *ctx.Model}
	}
	return clisdk.AgentLaunch{Env: util.NewObj(), Args: args, Strip: []string{}}
}

var Exec = sh.UsageDone

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Session:     &clisdk.SessionCustomization{Exec: Exec},
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch},
		Permissions: Permissions,
		History:     History,
		Progress:    &clisdk.ProgressCapability{WatchRoots: sh.Roots1(UserHome, ".gemini", "tmp")},
		Terminal:    sh.ResumeTerminal("gemini", "--resume"),
	}
}
