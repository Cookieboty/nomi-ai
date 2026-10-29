package mcp

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// Golden parity：scripts/parity/record-mcp.mjs 用 Node（@ai-sdk/mcp 2.0.73，与 packages/ai-runtime mcpBridge 同一份）
// 对 mcp-mock-server.mjs 录制客户端可见结果 + 完整双向 wire；本测试用 Go 客户端对同一 mock 跑同一组场景，逐字比对。
// 有 node + node_modules 时（CI 各平台均有）先现场录制本平台 golden；否则 Linux 本地回落到提交的 testdata。

type scenario struct {
	Name        string `json:"name"`
	WindowsOnly bool   `json:"windowsOnly"`
	TimeoutMs   *int64 `json:"timeoutMs"`
	Server      struct {
		Transport string   `json:"transport"`
		Variant   string   `json:"variant"`
		Env       *u.Obj   `json:"env"`
		Headers   *u.Obj   `json:"headers"`
		ExtraArgs []string `json:"extraArgs"`
		Command   string   `json:"command"`
		CmdShim   bool     `json:"cmdShim"`
	} `json:"server"`
	Steps []struct {
		Op   string `json:"op"`
		Name string `json:"name"`
		Args *u.Obj `json:"args"`
	} `json:"steps"`
}

func repoRoot() string { return filepath.Join("..", "..", "..", "..", "..") }

var uaRe = regexp.MustCompile(`node\.js/[0-9.v]+`)

func normUA(s string) string { return uaRe.ReplaceAllString(s, "node.js/<rt>") }

func errShape(err error) *u.Obj {
	o := u.NewObj("name", ErrorName(err), "message", err.Error())
	var ce *ClientError
	var se *nodeproc.SpawnError
	var nf *crossNotFound
	switch {
	case errors.As(err, &ce):
		if ce.Code != nil {
			o.Set("code", *ce.Code)
		}
		if ce.HasData {
			o.Set("data", ce.Data)
		}
		if ce.StatusCode != 0 {
			o.Set("statusCode", float64(ce.StatusCode))
		}
		if ce.ResponseBody != nil {
			o.Set("responseBody", *ce.ResponseBody)
		}
	case errors.As(err, &se):
		o.Set("name", "Error")
		o.Set("code", se.Code)
	case errors.As(err, &nf):
		o.Set("name", "Error")
		o.Set("code", "ENOENT")
	}
	return o
}

func pairs(o *u.Obj) [][2]string {
	if o == nil {
		return nil
	}
	out := [][2]string{}
	for _, k := range o.Keys() {
		out = append(out, [2]string{k, fmt.Sprint(o.Get(k))})
	}
	return out
}

type mockHTTP struct {
	cmd  *exec.Cmd
	port int
}

func startMockHTTP(t *testing.T, mock string) *mockHTTP {
	cmd := exec.Command("node", mock, "http")
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	_ = stdin
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var p struct{ Port int }
	if err := json.Unmarshal([]byte(line), &p); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return &mockHTTP{cmd: cmd, port: p.Port}
}

func (m *mockHTTP) log(t *testing.T) any {
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/__log?reset=1", m.port))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	v, err := u.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func runGoScenario(t *testing.T, sc scenario, mock string, m *mockHTTP, tmp string) *u.Obj {
	s := sc.Server
	results := []any{}
	timeout := int64(30000)
	if sc.TimeoutMs != nil {
		timeout = *sc.TimeoutMs
	}
	cfg := ClientConfig{InitializationOptions: &RequestOptions{Timeout: &timeout}}
	logFile := ""
	if s.Transport == "stdio" {
		logFile = filepath.Join(tmp, "go-"+sc.Name+".jsonl")
		env := append(pairs(s.Env), [2]string{"MCP_WIRE_LOG", logFile})
		command := "node"
		variant := s.Variant
		if variant == "" {
			variant = "legacy"
		}
		args := append([]string{mock, "stdio", variant}, s.ExtraArgs...)
		if s.CmdShim {
			command = filepath.Join(filepath.Dir(mock), "mcp-mock.cmd")
			args = append([]string{"stdio", s.Variant}, s.ExtraArgs...)
		}
		if s.Command != "" {
			command, args = s.Command, []string{}
		}
		cfg.Transport = NewStdioTransport(StdioConfig{Command: command, Args: args, Env: env})
	} else {
		m.log(t)
		kind := "mcp"
		if s.Transport == "sse" {
			kind = "sse"
		}
		cfg.TransportConfig = &TransportConfig{Type: s.Transport, URL: fmt.Sprintf("http://127.0.0.1:%d/%s/%s", m.port, s.Variant, kind), Headers: pairs(s.Headers)}
	}
	c, err := CreateClient(cfg)
	if err != nil {
		results = append(results, u.NewObj("op", "connect", "error", errShape(err)))
	} else {
		results = append(results, u.NewObj("op", "connect", "ok", true))
		for _, st := range sc.Steps {
			var v *u.Obj
			var err error
			switch st.Op {
			case "listTools":
				v, err = c.ListTools(nil, &RequestOptions{Timeout: &timeout})
			case "callTool":
				args := st.Args
				if args == nil {
					args = u.NewObj()
				}
				v, err = c.CallTool(st.Name, args, nil)
			case "close":
				err = c.Close()
			}
			switch {
			case err != nil:
				results = append(results, u.NewObj("op", st.Op, "error", errShape(err)))
			case st.Op == "close":
				results = append(results, u.NewObj("op", st.Op, "ok", true))
			default:
				results = append(results, u.NewObj("op", st.Op, "value", v))
			}
		}
	}
	time.Sleep(300 * time.Millisecond)
	var wire any = []any{}
	if logFile != "" {
		if b, err := os.ReadFile(logFile); err == nil {
			arr := []any{}
			for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
				if l == "" {
					continue
				}
				v, err := u.ParseString(l)
				if err != nil {
					t.Fatal(err)
				}
				arr = append(arr, v)
			}
			wire = arr
		}
	} else {
		wire = m.log(t)
	}
	wire, _ = u.ParseString(normUA(u.Stringify(wire)))
	return u.NewObj("name", sc.Name, "results", results, "wire", wire)
}

// diffScenario：返回首个差异（"" = 一致）。
func diffScenario(want, got any) string {
	return diffAt("", want, got)
}

func diffAt(p string, a, b any) string {
	switch av := a.(type) {
	case *u.Obj:
		bv, ok := b.(*u.Obj)
		if !ok {
			return p + ": type mismatch"
		}
		ka, kb := av.Keys(), bv.Keys()
		sort.Strings(ka)
		sort.Strings(kb)
		if strings.Join(ka, ",") != strings.Join(kb, ",") {
			return fmt.Sprintf("%s: keys %v vs %v", p, ka, kb)
		}
		// 键序也算 wire 细节（JSON 文本另行比对）
		for _, k := range av.Keys() {
			if d := diffAt(p+"."+k, av.Get(k), bv.Get(k)); d != "" {
				return d
			}
		}
		return ""
	case []any:
		bv, ok := b.([]any)
		if !ok {
			return p + ": type mismatch"
		}
		n := len(av)
		if len(bv) < n {
			n = len(bv)
		}
		for i := 0; i < n; i++ {
			if d := diffAt(fmt.Sprintf("%s[%d]", p, i), av[i], bv[i]); d != "" {
				return d
			}
		}
		if len(av) != len(bv) {
			return fmt.Sprintf("%s: len %d vs %d", p, len(av), len(bv))
		}
		return ""
	}
	if u.Stringify(a) != u.Stringify(b) {
		return fmt.Sprintf("%s: %s vs %s", p, u.Stringify(a), u.Stringify(b))
	}
	return ""
}

func loadGolden(t *testing.T, tmp string) (*u.Obj, string) {
	root := repoRoot()
	rec := filepath.Join(root, "scripts", "parity", "record-mcp.mjs")
	if _, err := exec.LookPath("node"); err != nil {
		paritytest.SkipOrFail(t, "node not found")
	}
	if _, err := os.Stat(filepath.Join(root, "node_modules", "@ai-sdk", "mcp")); err == nil {
		out := filepath.Join(tmp, "mcp-wire.json")
		cmd := exec.Command("node", rec, out)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			t.Fatalf("node recorder: %v", err)
		}
		return readGolden(t, out), "live:" + runtime.GOOS
	}
	if os.Getenv("CI") != "" {
		t.Fatal("node_modules/@ai-sdk/mcp missing in CI (pnpm install required)")
	}
	if runtime.GOOS != "linux" {
		t.Skip("committed golden is linux; no node_modules for live recording")
	}
	return readGolden(t, filepath.Join("testdata", "mcp-wire.json")), "committed"
}

func readGolden(t *testing.T, p string) *u.Obj {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	v, err := u.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return u.AsObj(v)
}

func TestMCPParityGolden(t *testing.T) {
	tmp := t.TempDir()
	golden, src := loadGolden(t, tmp)
	root := repoRoot()
	mock, _ := filepath.Abs(filepath.Join(root, "scripts", "parity", "mcp-mock-server.mjs"))
	var scs []scenario
	b, err := os.ReadFile(filepath.Join(root, "scripts", "parity", "mcp-scenarios.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &scs); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{}
	for _, s := range golden.Get("scenarios").([]any) {
		want[u.AsObj(s).Get("name").(string)] = s
	}
	m := startMockHTTP(t, mock)
	n, mutated := 0, 0
	for _, sc := range scs {
		if sc.WindowsOnly && runtime.GOOS != "windows" {
			continue
		}
		sc := sc
		t.Run(sc.Name, func(t *testing.T) {
			w, ok := want[sc.Name]
			if !ok {
				t.Fatalf("golden (%s) has no scenario %s", src, sc.Name)
			}
			got := runGoScenario(t, sc, mock, m, tmp)
			if d := diffScenario(w, got); d != "" {
				t.Fatalf("[%s] mismatch %s\nwant: %s\ngot:  %s", src, d, u.Stringify(w), u.Stringify(got))
			}
			if u.Stringify(w) != u.Stringify(got) {
				t.Fatalf("[%s] key order mismatch\nwant: %s\ngot:  %s", src, u.Stringify(w), u.Stringify(got))
			}
			n++
			// mutation check：篡改 golden 任一结果/wire 项必须被比对器发现
			for _, field := range []string{"results", "wire"} {
				arr, _ := u.AsObj(w).Get(field).([]any)
				for i := range arr {
					mut, _ := u.ParseString(u.Stringify(w))
					ma := u.AsObj(mut).Get(field).([]any)
					ma[i] = u.NewObj("mutated", float64(i))
					if diffScenario(mut, got) == "" {
						t.Fatalf("mutation %s[%d] not detected", field, i)
					}
					mutated++
				}
			}
		})
	}
	t.Logf("mcp parity (%s): %d scenarios equal, %d mutations detected", src, n, mutated)
}
