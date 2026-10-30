package codinghandlers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// #197：harness.gitCommit 经 Router → 处理函数 → Orchestrator.GitCommitIn → cli.GitCommit 的完整边界。
// 界面在有已暂存内容时传 paths:null，只提交暂存区（同 TS gitCommit 的 paths != null）。
func TestHarnessGitCommitPaths(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git missing")
	}
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	work := filepath.Join(tmp, "work")
	if err := os.WriteFile(filepath.Join(tmp, "gitconfig"), []byte("[user]\n\tname = T\n\temail = t@x\n[core]\n\tautocrlf = false\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": filepath.Join(tmp, "gitconfig"), "LANG": "C", "LC_ALL": "C"} {
		t.Setenv(k, v)
	}
	git := func(args ...string) string {
		t.Helper()
		c := exec.Command("git", args...)
		c.Dir = work
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(work, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.MkdirAll(work, 0o755)
	git("init", "-q", "-b", "main")
	write("a.txt", "a\n")
	write("b.txt", "b\n")
	git("add", "-A")
	git("commit", "-q", "-m", "init")

	idle := 0.0
	o := jsrt.Call(func() *harness.Orchestrator {
		return harness.New(harness.Deps{Root: filepath.Join(tmp, "harness"), Home: tmp,
			DefaultCwd: work, LegacyDefaultCwd: tmp, Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle})
	})
	defer jsrt.Run(func() { o.FlushPersist(); o.Dispose() })
	r := contract.NewRouter()
	RegisterHarness(r, func() *harness.Orchestrator { return o })
	ch := make(chan contract.ServerFrame, 8)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) {
		if f.T == "res" || f.T == "err" {
			ch <- f
		}
	})
	defer s.Close()
	n := 0
	// input 是原始 JSON，paths:null 按线上原样送进去
	commit := func(input string) map[string]any {
		t.Helper()
		n++
		fr, _ := json.Marshal(contract.ClientFrame{T: "req", ID: fmt.Sprint(n), Kind: "call", Name: "harness.gitCommit",
			Input: json.RawMessage(strings.ReplaceAll(input, "$W", strings.ReplaceAll(work, `\`, `\\`)))})
		s.Handle(fr)
		select {
		case f := <-ch:
			if f.Error != nil {
				t.Fatalf("%s: %s %s", input, f.Error.Code, f.Error.Message)
			}
			b, _ := json.Marshal(f.Output)
			var v map[string]any
			_ = json.Unmarshal(b, &v)
			return v
		case <-time.After(30 * time.Second):
			t.Fatalf("%s: timeout", input)
		}
		return nil
	}
	expect := func(v map[string]any, ok bool, code string) {
		t.Helper()
		if v["ok"] != ok || (code != "" && v["code"] != code) {
			t.Fatalf("want ok=%v code=%q, got %v", ok, code, v)
		}
	}

	// 只暂存 a.txt，b.txt 留在工作区：paths:null 只提交 a.txt
	write("a.txt", "a2\n")
	write("b.txt", "b2\n")
	git("add", "a.txt")
	head := git("rev-parse", "HEAD")
	v := commit(`{"cwd":"$W","message":"staged only","paths":null}`)
	expect(v, true, "")
	if v["sha"] == head || v["sha"] != git("rev-parse", "HEAD") {
		t.Fatalf("no new commit: %v", v)
	}
	if got := git("show", "--name-only", "--format=", "HEAD"); got != "a.txt" {
		t.Fatalf("committed files = %q, want a.txt", got)
	}
	if st := git("status", "--porcelain"); st != "M b.txt" {
		t.Fatalf("status after commit = %q, want unstaged b.txt", st)
	}

	// 缺省 paths 同 null；暂存区为空时是 nothing（不扩大暂存范围）
	expect(commit(`{"cwd":"$W","message":"none staged"}`), false, "nothing")
	expect(commit(`{"cwd":"$W","message":"none staged","paths":null}`), false, "nothing")

	// 空数组、越界路径、非法消息仍拒绝
	expect(commit(`{"cwd":"$W","message":"m","paths":[]}`), false, "invalid")
	expect(commit(`{"cwd":"$W","message":"m","paths":["../x"]}`), false, "invalid")
	expect(commit(`{"cwd":"$W","message":"  ","paths":null}`), false, "invalid")

	// 显式 paths 先暂存再提交
	v = commit(`{"cwd":"$W","message":"explicit","paths":["b.txt"]}`)
	expect(v, true, "")
	if got := git("show", "--name-only", "--format=", "HEAD"); got != "b.txt" {
		t.Fatalf("committed files = %q, want b.txt", got)
	}
	if st := git("status", "--porcelain"); st != "" {
		t.Fatalf("status after explicit commit = %q", st)
	}
}
