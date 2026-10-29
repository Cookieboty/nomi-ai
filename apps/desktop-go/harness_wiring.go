package main

import (
	"log"
	"os"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// harnessPorts：HarnessPorts（dialogs.pickDirectory / windows.anyFocused）
type harnessPorts struct{ hp hostPorts }

func (p harnessPorts) PickDirectory(title string, _ bool, def string) *string {
	d, err := p.hp.PickDir(title, "", def)
	if err != nil || d == "" {
		return nil
	}
	return &d
}

// AnyFocused：Go 壳尚无窗口焦点查询（壳层过程归 feat/2.0.5-go-shell），先按未聚焦处理
func (harnessPorts) AnyFocused() bool { return false }

type stdLogger struct{}

func (stdLogger) Info(m string, d any) { log.Printf("[harness] %s %v", m, d) }
func (stdLogger) Warn(m string, d any) { log.Printf("[harness] WARN %s %v", m, d) }

// wireHarness 对齐 createCore.ts 的 HarnessOrchestrator 构造 + coding.ts 的 harness.* 过程。
// gateway / accounts / externals 暂未接入（Node 侧同为可选依赖）。
func wireHarness(router *contract.Router, userData, home string, hp hostPorts) func() {
	docs := filepath.Join(home, "Documents")
	o := jsrt.Call(func() *harness.Orchestrator {
		return harness.New(harness.Deps{
			Root: filepath.Join(userData, "harness"), Logger: stdLogger{}, Home: home,
			DefaultCwd: filepath.Join(docs, "nomi"), LegacyDefaultCwd: docs,
			Ports:          harnessPorts{hp},
			PrewarmClaude:  os.Getenv("NOMI_HARNESS_PREWARM") != "0",
			GrokAcp:        os.Getenv("NOMI_GROK_ACP") != "0",
			CodexAppServer: os.Getenv("NOMI_CODEX_APP_SERVER") != "0",
		})
	})
	codinghandlers.RegisterHarness(router, func() *harness.Orchestrator { return o })
	return func() { jsrt.Run(func() { o.Dispose() }) }
}
