package gemini

import (
	"path/filepath"
	"regexp"
	"strings"

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

// UntrustedExitCode 是 Gemini CLI 拒绝在未信任目录运行的退出码。
const UntrustedExitCode = 55

var (
	untrustedRe     = regexp.MustCompile(`(?i)not running in a trusted directory|--skip-trust|GEMINI_CLI_TRUST_WORKSPACE`)
	untrustedModeRe = regexp.MustCompile(`(?i)approval modes? in an untrusted folder`)
)

// ExtraAcpArgs：Gemini ACP 额外目录通过 --include-directories 参数传入。
func ExtraAcpArgs(dirs []string) []string {
	var out []string
	for _, d := range dirs {
		if strings.TrimSpace(d) != "" {
			out = append(out, "--include-directories", d)
		}
	}
	return out
}

// IsUntrustedModeError：Gemini 拒绝在没信任的文件夹里切到「自动编辑 / 完全放开」。
func IsUntrustedModeError(msg string) bool { return untrustedModeRe.MatchString(msg) }

// IsUntrustedExit：判断 Gemini CLI 是否因未信任目录而退出。
func IsUntrustedExit(exitCode *int, stderr string) bool {
	return (exitCode != nil && *exitCode == UntrustedExitCode) || untrustedRe.MatchString(stderr)
}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Session:     &clisdk.SessionCustomization{Exec: Exec},
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch},
		Permissions: Permissions,
		History:     History,
		Progress:    &clisdk.ProgressCapability{WatchRoots: sh.Roots1(UserHome, ".gemini", "tmp")},
		Terminal:    sh.ResumeTerminal("gemini", "--resume"),
		Acp: &clisdk.AcpCapability{
			ExtraArgs:            ExtraAcpArgs,
			IsUntrustedModeError: IsUntrustedModeError,
			IsUntrustedExit:      IsUntrustedExit,
			AuthRequiredKey:      "electron.common.gemini-needs-auth",
		},
	}
}
