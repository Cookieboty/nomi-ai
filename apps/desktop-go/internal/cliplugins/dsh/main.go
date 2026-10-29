package dsh

import (
	"path/filepath"
	"regexp"
	"strings"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const HomeEnv = "DSH_HOME"

var Modes = []string{"plan", "acceptEdits", "bypass"}

func UserHome(env clisdk.Env, home string) string { return sh.CliHome(HomeEnv, ".dsh", env, home) }

func launch(mode string, _ *bool) ([]string, *util.Obj) {
	sandbox := "workspace-write"
	if mode == "plan" {
		sandbox = "read-only"
	} else if mode == "bypass" {
		sandbox = "danger-full-access"
	}
	return []string{}, util.NewObj("DSH_PERMISSION_MODE", sandbox)
}

var Permissions = &clisdk.PermissionCapability{
	Supported:  Modes,
	Launch:     launch,
	FromModeID: sh.FromModeID(Modes, ""),
	PlanPrefix: sh.PlanPromptPrefix,
}

var sessFileRe = regexp.MustCompile(`^session\.v\d+\.jsonl`)

var History = &clisdk.HistoryCapability{
	Roots: sh.Roots1(UserHome, "sessions"),
	Scan: func(root string) []clisdk.HistoryFileRef {
		files := []sh.FileCand{}
		for _, proj := range sh.Readdir(root) {
			if !sh.IsDirentDir(proj) {
				continue
			}
			for _, s := range sh.Readdir(filepath.Join(root, proj.Name())) {
				if !sh.IsDirentDir(s) || !strings.HasPrefix(s.Name(), "session-") {
					continue
				}
				dir := filepath.Join(root, proj.Name(), s.Name())
				for _, x := range sh.Readdir(dir) {
					if sh.IsDirentFile(x) && sessFileRe.MatchString(x.Name()) {
						files = append(files, sh.FileCand{Path: filepath.Join(dir, x.Name()), DirID: s.Name()})
						break
					}
				}
			}
		}
		return sh.StatAll(files)
	},
	Parse:  sh.HistoryParse("dsh", ParseTranscript),
	Resume: func(id string) *util.Obj { return sh.Resume([]string{"--session-id", id}, false) },
}

func OfficialLaunch(ctx clisdk.LaunchContext) clisdk.AgentLaunch {
	_, env := launch(ctx.PermissionMode, nil)
	return clisdk.AgentLaunch{Env: env, Args: []string{"--profile", "headless", "--json"}, Strip: []string{}}
}

var Exec = &clisdk.ExecRules{
	Completes: func(ev clisdk.Ev) bool {
		return ev.Get("type") == "done" && (util.Truthy(ev.Get("usage")) || !util.Truthy(ev.Get("sessionId")))
	},
	SilentExitIsError: true,
}

func CreateMain() *clisdk.CliMainImpl {
	return &clisdk.CliMainImpl{
		Session:     &clisdk.SessionCustomization{Exec: Exec},
		Launch:      clisdk.LaunchCapability{Official: OfficialLaunch},
		Permissions: Permissions,
		History:     History,
		Progress:    &clisdk.ProgressCapability{WatchRoots: sh.Roots1(UserHome, "sessions")},
		Usage:       &clisdk.UsageCapability{LogRoots: sh.Roots1(UserHome, "sessions")},
	}
}
