package cli

import (
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// HarnessLaunch = HarnessLaunch。
type HarnessLaunch struct {
	File     string
	Args     []string
	Env      *util.Obj
	Verbatim bool
}

// ResolveHarnessLaunch = resolveHarnessLaunch。nodeBin：nil = undefined（调用 resolveNodeBin），指向 "" = null。
func ResolveHarnessLaunch(command string, args []string, env *util.Obj, platform string, nodeBin *string) HarnessLaunch {
	if platform == "" {
		platform = usage.Platform()
	}
	bin := WindowsExecutable(command, platform, nil)
	launch := usage.ResolveCliLaunch(bin, args, env, platform, usage.UnwrapCmdDeps{})
	if launch == nil {
		return HarnessLaunch{File: bin, Args: args, Env: env}
	}
	if launch.Via == usage.ViaNodeScript {
		var resolved string
		if nodeBin == nil {
			resolved = ResolveNodeBin()
		} else {
			resolved = *nodeBin
		}
		file := launch.File
		if !filepath.IsAbs(launch.File) && resolved != "" {
			file = resolved
		}
		return HarnessLaunch{File: file, Args: launch.Args, Env: WithCliPath(env)}
	}
	return HarnessLaunch{File: launch.File, Args: launch.Args, Env: env, Verbatim: launch.Via == usage.ViaCmdShim}
}
