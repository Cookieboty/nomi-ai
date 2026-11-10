package sandbox

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 真跑 sandbox-exec：补上的凭据位置拒读；CLI 的钩子与配置、PATH 可执行目录拒写（CLI 自己的会话照写）；
// ssh-agent / Docker 的 socket 没授权对应类别时连不上；Apple Events 一律拒
func TestProfileClosesGaps(t *testing.T) {
	if !Supported() {
		t.Skip("sandbox-exec not available")
	}
	tmp := t.TempDir()
	home := filepath.Join(tmp, "home")
	for p, v := range map[string]string{
		filepath.Join(home, ".npmrc"):                  "//registry.npmjs.org/:_authToken=x",
		filepath.Join(home, ".zsh_history"):            "export TOKEN=x",
		filepath.Join(home, ".config", "op", "config"): "c",
	} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(v), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	spec := Spec{Token: "t2", Home: home, Cwd: filepath.Join(tmp, "proj"), CwdWritable: true}
	run := func(s Spec, args ...string) bool {
		return exec.Command(Exec, append([]string{"-p", Profile(s)}, args...)...).Run() == nil
	}
	for _, p := range []string{".zsh_history", ".config/op/config"} {
		if run(spec, "/bin/cat", filepath.Join(home, p)) {
			t.Errorf("read ~/%s must be denied", p)
		}
	}
	// ~/.npmrc 放开读（镜像源配置），但不能写（script-shell / node-options 会在沙箱外执行）
	if !run(spec, "/bin/cat", filepath.Join(home, ".npmrc")) {
		t.Error("read ~/.npmrc should be allowed")
	}
	if run(spec, "/bin/sh", "-c", `echo "script-shell=/tmp/x" >> "$1"`, "sh", filepath.Join(home, ".npmrc")) {
		t.Error("write ~/.npmrc must be denied")
	}
	write := func(s Spec, p string) bool {
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		return run(s, "/bin/sh", "-c", `echo x > "$1"`, "sh", p)
	}
	// 版本管理器的命令入口：隐藏目录默认可写，这些仍要拒（#302）。测试的主目录在临时目录下、本来就可写，
	// 拒绝规则排在放行之后，所以这里验证的是实际生效的策略，不是配置里有没有某个字符串
	for _, p := range []string{".claude/settings.json", ".claude/hooks/pre.sh", ".codex/config.toml", ".bun/bin/node",
		".pyenv/shims/python", ".pyenv/bin/pyenv", ".rbenv/shims/ruby", ".asdf/shims/node", ".local/share/mise/shims/node",
		".volta/bin/node"} {
		if write(spec, filepath.Join(home, p)) {
			t.Errorf("write ~/%s must be denied", p)
		}
	}
	// 普通的工具状态照常能写（隐藏目录、pyenv 自己的缓存）
	for _, p := range []string{".cache/tool/state", ".pyenv/cache/x", ".npm/_logs/x.log"} {
		if !write(spec, filepath.Join(home, p)) {
			t.Errorf("tool state ~/%s stays writable", p)
		}
	}
	if !write(spec, filepath.Join(home, ".claude", "projects", "s.jsonl")) {
		t.Error("the CLI still writes its own sessions")
	}

	// socket：路径要短（Unix socket 路径上限），放在 /tmp 下
	dir, err := os.MkdirTemp("/tmp", "nsb")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	connect := func(s Spec, sock string) bool {
		return run(s, "/usr/bin/nc", "-U", "-w", "1", sock)
	}
	for _, c := range []struct{ name, grant string }{{"agent.sock", "ssh"}, {"docker.sock", "cloud"}} {
		sock := filepath.Join(dir, c.name)
		ln, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				_, _ = conn.Write([]byte("hi\n"))
				conn.Close()
			}
		}()
		if connect(spec, sock) {
			t.Errorf("connecting to %s must be denied without the %s category", c.name, c.grant)
		}
		granted := spec
		granted.Granted = map[string]bool{c.grant: true}
		if !connect(granted, sock) {
			t.Errorf("granting %s allows %s", c.grant, c.name)
		}
		ln.Close()
	}
	if !strings.Contains(Profile(spec), "(deny appleevent-send") {
		t.Error("Apple Events are denied")
	}
}
