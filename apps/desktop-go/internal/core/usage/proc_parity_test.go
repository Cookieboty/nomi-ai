package usage

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 回放 scripts/parity/record-usage-proc.mjs：grokAuth（parseGrokAuthStatus / readGrokAuthStatus）与
// limitedProcess（killTree / windowsShimLaunch / unwrapWindowsCmdShim / resolveCliLaunch / runLimited）。

type procGolden struct {
	Consts struct {
		AgentArgs   []string `json:"agentArgs"`
		AuthTimeout int      `json:"authTimeout"`
		StdoutLimit int      `json:"stdoutLimit"`
	} `json:"consts"`
	AuthText []struct {
		Text string `json:"text"`
		Out  string `json:"out"`
	} `json:"authText"`
	Shim []struct {
		Command string          `json:"command"`
		Args    []string        `json:"args"`
		Env     json.RawMessage `json:"env"`
		Out     string          `json:"out"`
	} `json:"shim"`
	UnwrapCases []struct {
		Command  string   `json:"command"`
		Exists   string   `json:"exists"`
		Platform string   `json:"platform"`
		Out      string   `json:"out"`
		Calls    []string `json:"calls"`
		Launch   string   `json:"launch"`
	} `json:"unwrapCases"`
	KillCases []struct {
		Name            string   `json:"name"`
		ExitAfterTerm   bool     `json:"exitAfterTerm"`
		SignalAfterTerm bool     `json:"signalAfterTerm"`
		TermThrows      bool     `json:"termThrows"`
		KillThrows      bool     `json:"killThrows"`
		Sync            []string `json:"sync"`
		Calls           []string `json:"calls"`
	} `json:"killCases"`
	Run  []subsScenarioProc `json:"run"`
	Auth []subsScenarioProc `json:"auth"`
}

type subsScenarioProc struct {
	subsScenario
	MaxBytes int    `json:"maxBytes"`
	Out      string `json:"out"`
}

func loadProcGolden(t *testing.T) (*subsHarness, procGolden) {
	h := newSubsHarness(t) // node + mock cli + 私有临时目录
	path := "testdata/usage-proc.json"
	if dir := os.Getenv("NOMI_LIVE_GOLDENS"); dir != "" {
		path = filepath.Join(dir, "usage-proc.json")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g procGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return h, g
}

func TestGrokAuthAndShimPureParity(t *testing.T) {
	_, g := loadProcGolden(t)
	if util.Stringify(GrokAgentArgs) != util.Stringify(g.Consts.AgentArgs) || GrokAuthTimeoutMs != g.Consts.AuthTimeout || StdoutLimit != g.Consts.StdoutLimit {
		t.Errorf("consts: go %v %d %d node %+v", GrokAgentArgs, GrokAuthTimeoutMs, StdoutLimit, g.Consts)
	}
	for i, c := range g.AuthText {
		got := "null"
		if m := ParseGrokAuthStatus(c.Text); m != "" {
			got = util.Stringify(m)
		}
		if got != c.Out {
			t.Errorf("parseGrokAuthStatus[%d] %q: go %s node %s", i, c.Text, got, c.Out)
		}
	}
	for i, c := range g.Shim {
		env := mustParse(t, c.Env).(*util.Obj)
		got := "null"
		if f, a, ok := WindowsShimLaunch(c.Command, c.Args, env); ok {
			got = util.Stringify(util.NewObj("file", f, "args", a))
		}
		if got != c.Out {
			t.Errorf("windowsShimLaunch[%d]: go %s node %s", i, got, c.Out)
		}
	}
}

// unwrap 场景的 deps：与录制端同一份虚拟文件系统（路径分隔符跟随平台）
func procUnwrapDeps(mode string, calls *[]string) UnwrapCmdDeps {
	S := string(filepath.Separator)
	P := func(xs ...string) string { return strings.Join(xs, S) }
	shimText := func(body string) string {
		return "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\n" + body + "\r\n"
	}
	files := map[string]string{
		P("", "n", "npm", "grok.cmd"):   shimText(`"%_prog%" "%dp0%\node_modules\@x\grok\bin\grok.js" %*` + "\r\n" + `IF EXIST "%dp0%\node.exe" ( SET "_prog=%dp0%\node.exe" )`),
		P("", "n", "pnpm", "grok.CMD"):  shimText(`"%~dp0\..\store\node.exe" "%~dp0\..\store\grok\dist\cli.mjs" %*`),
		P("", "n", "pnpm", "other.bat"): shimText(`"C:/tools/node" "%~dp0/a.cjs" "%~dp0/b.txt"`),
		P("", "n", "x", "nojs.cmd"):     shimText(`"%dp0%\bin\grok" %*`),
		P("", "n", "x", "pct.cmd"):      shimText(`"%dp0%\%weird%\g.js"`),
		P("", "n", "x", "empty.cmd"):    "\"\"\r\n\"%~dp0g.js\"",
		P("", "n", "x", "q.cmd"):        `"%~dp0g.js" "node" "%~dp0..\..\node"`,
	}
	all := map[string]bool{
		P("", "n", "npm", "node_modules", "@x", "grok", "bin", "grok.js"): true,
		P("", "n", "npm", "node.exe"):                                     true,
		P("", "store", "node.exe"):                                        true, P("", "n", "store", "node.exe"): true,
		P("", "n", "store", "grok", "dist", "cli.mjs"): true,
		P("", "n", "pnpm", "a.cjs"):                    true,
		P("", "n", "x", "g.js"):                        true,
		"node":                                         true, P("", "node"): true,
	}
	nodeExe := regexp.MustCompile(`node\.exe$`)
	return UnwrapCmdDeps{
		ReadFile: func(p string) (string, error) {
			if s, ok := files[p]; ok {
				return s, nil
			}
			return "", errors.New("ENOENT")
		},
		Exists: func(p string) bool {
			if calls != nil {
				*calls = append(*calls, p)
			}
			switch mode {
			case "all":
				return all[p]
			case "none":
				return false
			}
			return all[p] && !nodeExe.MatchString(p)
		},
	}
}

func TestUnwrapAndResolveCliLaunchParity(t *testing.T) {
	_, g := loadProcGolden(t)
	for i, c := range g.UnwrapCases {
		if c.Platform == "" {
			calls := []string{}
			got := "null"
			if n, s, ok := UnwrapWindowsCmdShim(c.Command, procUnwrapDeps(c.Exists, &calls)); ok {
				got = util.Stringify(util.NewObj("node", n, "script", s))
			}
			if got != c.Out {
				t.Errorf("unwrap[%d] %s/%s: go %s node %s", i, c.Command, c.Exists, got, c.Out)
			}
			want := c.Calls
			if want == nil {
				want = []string{}
			}
			if util.Stringify(calls) != util.Stringify(want) {
				t.Errorf("unwrap[%d] %s/%s exists calls: go %v node %v", i, c.Command, c.Exists, calls, want)
			}
			continue
		}
		got := "null"
		if l := ResolveCliLaunch(c.Command, []string{"agent", "stdio"}, util.NewObj("ComSpec", "cmd.exe"), c.Platform, procUnwrapDeps(c.Exists, nil)); l != nil {
			got = util.Stringify(util.NewObj("file", l.File, "args", l.Args, "via", string(l.Via)))
		}
		if got != c.Launch {
			t.Errorf("resolveCliLaunch[%d] %s/%s/%s: go %s node %s", i, c.Command, c.Exists, c.Platform, got, c.Launch)
		}
	}
}

type fakeKill struct {
	calls                 []string
	exit                  *int
	sig                   string
	exitAfter, sigAfter   bool
	termThrows, killThrow bool
}

func (f *fakeKill) Kill(s string) bool {
	f.calls = append(f.calls, s)
	if s == "SIGTERM" {
		if f.exitAfter {
			z := 0
			f.exit = &z
		}
		if f.sigAfter {
			f.sig = "SIGTERM"
		}
		if f.termThrows {
			panic(jsrt.JSThrow{Message: "t"})
		}
	}
	if s == "SIGKILL" && f.killThrow {
		panic(jsrt.JSThrow{Message: "k"})
	}
	return true
}
func (f *fakeKill) ExitCode() *int     { return f.exit }
func (f *fakeKill) SignalCode() string { return f.sig }

func TestKillTreeParity(t *testing.T) {
	_, g := loadProcGolden(t)
	for _, c := range g.KillCases {
		f := &fakeKill{exitAfter: c.ExitAfterTerm, sigAfter: c.SignalAfterTerm, termThrows: c.TermThrows, killThrow: c.KillThrows}
		var sync []string
		jsrt.Run(func() {
			KillTree(f, 50)
			sync = append([]string{}, f.calls...)
			jsrt.Sleep(150 * time.Millisecond)
		})
		if util.Stringify(sync) != util.Stringify(c.Sync) || util.Stringify(f.calls) != util.Stringify(c.Calls) {
			t.Errorf("killTree/%s: go %v/%v node %v/%v", c.Name, sync, f.calls, c.Sync, c.Calls)
		}
	}
}

func TestRunLimitedParity(t *testing.T) {
	h, g := loadProcGolden(t)
	for _, sc := range g.Run {
		logf := h.logFile()
		cwd := filepath.Join(h.tmp, "run")
		_ = os.MkdirAll(cwd, 0o755)
		bin := h.bin
		if sc.Name == "enoent" {
			bin = filepath.Join(filepath.Dir(h.bin), "no-such-usage-cli")
		}
		mb := sc.MaxBytes
		if mb == 0 {
			mb = StdoutLimit
		}
		var got string
		jsrt.Run(func() {
			r, err := jsrt.Await(RunLimited(bin, []string{"a", "", "b c"}, RunOptions{
				Cwd: cwd, Env: h.env(sc.subsScenario, logf)(), TimeoutMs: timeoutOr(sc.TimeoutMs, 10_000), MaxBytes: mb,
			}))
			if err != nil {
				var pf *ProcessFailure
				if errors.As(err, &pf) {
					got = util.Stringify(util.NewObj("fail", string(pf.Kind), "name", "ProcessFailure", "isPF", true))
				} else {
					got = fmt.Sprint("non-ProcessFailure: ", err)
				}
				return
			}
			var code any
			if r.Code != nil {
				code = float64(*r.Code)
			}
			got = util.Stringify(util.NewObj("stdout", r.Stdout, "code", code))
		})
		time.Sleep(time.Second)
		_ = os.RemoveAll(cwd)
		if got != sc.Out {
			t.Errorf("runLimited/%s: go %s node %s", sc.Name, got, sc.Out)
		}
		h.checkLog("run", sc.subsScenario, logf)
	}
}

func TestReadGrokAuthStatusParity(t *testing.T) {
	h, g := loadProcGolden(t)
	for _, sc := range g.Auth {
		logf := h.logFile()
		got := "null"
		jsrt.Run(func() {
			if s, ok := ReadGrokAuthStatus(GrokAuthReaderDeps{
				ResolveBin: h.resolve(sc.subsScenario),
				Env:        h.env(sc.subsScenario, logf),
				TmpRoot:    h.tmp,
				TimeoutMs:  timeoutOr(sc.TimeoutMs, 10_000),
			}); ok {
				got = util.Stringify(s)
			}
		})
		if got != sc.Out {
			t.Errorf("readGrokAuthStatus/%s: go %s node %s", sc.Name, got, sc.Out)
		}
		h.check("grokAuth", sc.subsScenario, nil, logf)
	}
}
