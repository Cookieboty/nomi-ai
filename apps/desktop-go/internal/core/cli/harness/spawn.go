package harness

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// mockDir = mockDir()：候选用 cli.MockCliRoots（前两项 __dirname bundle 目录由宿主接线 prepend）。
func mockDir() string {
	roots := cli.MockCliRoots()
	for _, c := range roots {
		if usage.ExistsSync(filepath.Join(c, "mock-claude.mjs")) {
			return c
		}
	}
	return roots[0]
}

// ResolveHarnessBin = resolveHarnessBin（"" = null）。
func ResolveHarnessBin(backend string) string {
	if os.Getenv("NOMI_USE_MOCK_CLI") == "1" {
		return filepath.Join(mockDir(), "mock-"+backend+".mjs")
	}
	return cli.ResolveCliBinCached(backend)
}

// PeekHarnessBin = peekHarnessBin（"" = null）。
func PeekHarnessBin(backend string) string {
	if os.Getenv("NOMI_USE_MOCK_CLI") == "1" {
		return ResolveHarnessBin(backend)
	}
	b, _ := cli.PeekCliBin(backend)
	return b
}

func IsScript(bin string) bool {
	return strings.HasSuffix(bin, ".mjs") || strings.HasSuffix(bin, ".js")
}

// CliTrap = currentCoreScope()?.cliTrace?.tap；batch 4/5 接线点（nil = 无 trace）。
var CliTrap func(child clisdk.ChildLike, command string, args []string, tabID string)

// SpawnHarness = spawnHarness。须在 jsrt.Run 内调用（nodeproc 约定）。stdin 'error' 由 nodeproc 吞掉。
func SpawnHarness(command string, args []string, cwd string, env *util.Obj, tabID string) clisdk.ChildLike {
	l := cli.ResolveHarnessLaunch(command, args, env, usage.Platform(), nil)
	ch := clisdk.ProcChild{Child: nodeproc.Spawn(l.File, l.Args, nodeproc.Options{Cwd: cwd, Env: usage.EnvSlice(l.Env), Verbatim: l.Verbatim})}
	if CliTrap != nil {
		CliTrap(ch, command, args, tabID)
	}
	return ch
}

// CliChildEnv = cliChildEnv。
func CliChildEnv(useNode bool, extra *util.Obj) *util.Obj {
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
	return cli.BuildCliEnv(cli.WithCliPath(usage.ProcessEnv()), extra)
}
