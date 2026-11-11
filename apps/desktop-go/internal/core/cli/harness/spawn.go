package harness

import (
	"errors"
	"os"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ResolveHarnessBin = resolveHarnessBin（"" = null）。
// NOMI_USE_MOCK_CLI=1 时只认真实存在的假 CLI。文件不在就当没安装，
// 不要编一个不存在的路径（否则委派会把所有助手当成已安装）。
func ResolveHarnessBin(backend string) string {
	if os.Getenv("NOMI_USE_MOCK_CLI") == "1" {
		return cli.MockCliBin(backend)
	}
	return cli.ResolveCliBinCached(backend)
}

func IsScript(bin string) bool {
	return strings.HasSuffix(bin, ".mjs") || strings.HasSuffix(bin, ".js")
}

// CliTrap：CLI 子进程的 trace 钩子（nil = 无 trace）。
var CliTrap func(child clisdk.ChildLike, command string, args []string, tabID string)

// SpawnHarness = spawnHarness。须在 jsrt.Run 内调用（nodeproc 约定）。stdin 'error' 由 nodeproc 吞掉。
func SpawnHarness(command string, args []string, cwd string, env *util.Obj, tabID string) clisdk.ChildLike {
	return spawnHarness(command, args, cwd, env, tabID, nil)
}

// CliChildEnv = cliChildEnv：继承的环境去掉凭据变量（allow 里的放行，见 cli.ScrubSecretEnv），再叠上 extra。
func CliChildEnv(useNode bool, extra *util.Obj, allow []string) *util.Obj {
	if extra == nil {
		extra = util.NewObj()
	}
	if useNode {
		e := util.NewObj("ELECTRON_RUN_AS_NODE", "1")
		for _, k := range extra.Keys() {
			e.Set(k, extra.Get(k))
		}
		extra = e
	}
	base, _ := cli.ScrubSecretEnv(cli.WithCliPath(usage.ProcessEnv()), allow)
	return cli.BuildCliEnv(base, extra)
}

// GhTokenVars = GH_TOKEN_VARS：gh 读令牌的环境变量（环境变量优先于已存的登录）
var GhTokenVars = []string{"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"}

// IsolateGhEnv = isolateGhEnv：GH_CONFIG_DIR 指向空目录、去掉令牌变量、关交互（docs/features/scheduling-calendar.md）。
// 只是默认值，不是安全边界（真正的边界是命令分类与审批）。
func IsolateGhEnv(env *util.Obj, emptyConfigDir string) *util.Obj {
	out := env.Clone()
	for _, k := range GhTokenVars {
		out.Delete(k)
	}
	out.Set("GH_CONFIG_DIR", emptyConfigDir)
	out.Set("GH_PROMPT_DISABLED", "1")
	return out
}

// cwdErr：工作目录不符合策略（Deps.CwdCheck：与 Nomi 对话工作区同一套，不能过宽、不能在受保护文件夹里）
// 时给用户看的错误。选目录、新建标签、每次起 CLI 前都查。
func (o *Orchestrator) cwdErr(dir string) error {
	if o.d.CwdCheck == nil || dir == "" {
		return nil
	}
	if reason := o.d.CwdCheck(dir); reason != "" {
		return errors.New(i18n.T("electron.common.cli-cwd-blocked", dir, reason))
	}
	return nil
}

func (o *Orchestrator) checkCwd(dir string) {
	if err := o.cwdErr(dir); err != nil {
		throw(err.Error())
	}
}
