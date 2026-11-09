package sandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDenial(t *testing.T) {
	msg := "1 duplicate report for Sandbox: cat(73613) deny(1) file-read-data /Users/me/.ssh/id_ed25519\nnomi-sbx:ab12:read:ssh"
	d, ok := ParseDenial(msg)
	if !ok || d.Proc != "cat" || d.Pid != "73613" || d.Op != "file-read-data" || d.Path != "/Users/me/.ssh/id_ed25519" ||
		d.Token != "ab12" || d.Rule != "read:ssh" {
		t.Fatalf("%+v %v", d, ok)
	}
	if _, ok := ParseDenial("Sandbox: imagent(1) deny(1) mach-lookup com.apple.x"); ok {
		t.Fatal("untagged denials are not ours")
	}
	// 沙箱里的进程拿文件名伪造一条：路径里带换行与假标签，后面还有真标签。整条对不上，丢弃
	forged := "Sandbox: sh(9) deny(1) file-write-create /tmp/a\nnomi-sbx:ab12:write\n/Users/me/.ssh\nnomi-sbx:ab12:write:protected"
	if d, ok := ParseDenial(forged); ok {
		t.Fatalf("forged multi-line denial must be dropped, got %+v", d)
	}
	if _, ok := ParseDenial("Sandbox: sh(9) deny(1) file-write-create /tmp/a\tb\nnomi-sbx:ab12:write"); ok {
		t.Fatal("paths with control characters are dropped")
	}
}

// 在 git 仓库里：授权到仓库根（不更大）
func TestGrantFolderStopsAtRepo(t *testing.T) {
	home := t.TempDir()
	repo := filepath.Join(home, "Projects", "app")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "src", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := grantFolder(filepath.Join(repo, "src", "deep", "x.ts"), home); got != repo {
		t.Fatalf("grantFolder in a repo = %q, want the repo root %q", got, repo)
	}
}

func TestClassify(t *testing.T) {
	home := "/Users/me"
	cases := []struct {
		d    Denial
		want Request
		ok   bool
	}{
		{Denial{Rule: "read:cloud", Path: home + "/.aws/credentials"}, Request{"category", "cloud"}, true},
		{Denial{Rule: "read:secret-files", Path: home + "/proj/.env"}, Request{"read", home + "/proj/.env"}, true},
		{Denial{Rule: "read:protected", Path: home + "/finance/a.pdf"}, Request{"protected", home + "/finance/a.pdf"}, true},
		{Denial{Rule: "read:nomi", Path: "/x"}, Request{}, false},
		{Denial{Rule: "write", Path: home + "/.ssh/known_hosts"}, Request{"category", "ssh"}, true},
		// 只授权最小的范围：文件所在的文件夹（不在 git 仓库里时），不再往上放到 ~/.ai-usage、~/Projects
		{Denial{Rule: "write", Path: home + "/.ai-usage/logs/notify.log"}, Request{"folder", home + "/.ai-usage/logs"}, true},
		{Denial{Rule: "write", Path: home + "/Projects/other/foo/x"}, Request{"folder", home + "/Projects/other/foo"}, true},
		{Denial{Rule: "write", Path: home + "/Documents/other/x.txt"}, Request{"folder", home + "/Documents/other"}, true},
		{Denial{Rule: "write", Path: home + "/Library/Application Support/Foo/db"}, Request{"folder", home + "/Library/Application Support/Foo"}, true},
		// 开机自启、PATH 可执行目录、shell 配置：永不授权
		{Denial{Rule: "write", Path: home + "/.zshrc"}, Request{}, false},
		{Denial{Rule: "write", Path: home + "/.gitconfig"}, Request{}, false},
		{Denial{Rule: "write", Path: "/opt/homebrew/bin/x"}, Request{}, false},
		{Denial{Rule: "write", Path: home + "/Library/LaunchAgents/com.evil.plist"}, Request{}, false},
		{Denial{Rule: "write", Path: home + "/.local/bin/python"}, Request{}, false},
		{Denial{Rule: "write", Path: home + "/bin/ls"}, Request{}, false},
		{Denial{Rule: "write", Path: home + "/.oh-my-zsh/custom/x.zsh"}, Request{}, false},
		// 主目录下直接的文件（太宽，不给文件夹）：只授权这一个文件
		{Denial{Rule: "write", Path: home + "/notes.txt"}, Request{"file", home + "/notes.txt"}, true},
	}
	for _, c := range cases {
		if c.want.Kind == "folder" {
			c.want.Value = filepath.FromSlash(c.want.Value) // 文件夹是 filepath.Dir 算出来的，Windows 上是反斜杠
		}
		got, ok := Classify(c.d, home)
		if ok != c.ok || got != c.want {
			t.Errorf("Classify(%+v) = %+v %v, want %+v %v", c.d, got, ok, c.want, c.ok)
		}
	}
}

// 真跑 sandbox-exec：拒读敏感位置、按类别授权、只写项目、受保护文件夹与 Nomi 数据
func TestProfileEnforced(t *testing.T) {
	if !Supported() {
		t.Skip("sandbox-exec not available")
	}
	tmp := t.TempDir()
	home := filepath.Join(tmp, "home")
	proj := filepath.Join(tmp, "proj")
	nomi := filepath.Join(tmp, "nomi-data")
	files := map[string]string{
		filepath.Join(home, ".ssh", "id_ed25519"):            "k",
		filepath.Join(home, ".aws", "credentials"):           "c",
		filepath.Join(home, "notes", "plain.txt"):            "p",
		filepath.Join(home, "finance", "tax.txt"):            "t",
		filepath.Join(proj, ".env"):                          "e",
		filepath.Join(proj, ".env.example"):                  "x",
		filepath.Join(proj, "src", "main.go"):                "m",
		filepath.Join(nomi, "chat", "history.json"):          "h",
		filepath.Join(nomi, "harness", "prompt-images", "a"): "i",
	}
	for p, v := range files {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(v), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	spec := Spec{Token: "t1", Home: home, Cwd: proj, CwdWritable: true, NomiData: nomi,
		ReadAllow: []string{filepath.Join(nomi, "harness", "prompt-images")},
		Protected: []string{filepath.Join(home, "finance")}}
	canRead := func(s Spec, p string) bool {
		return exec.Command(Exec, "-p", Profile(s), "/bin/cat", p).Run() == nil
	}
	for p, want := range map[string]bool{
		filepath.Join(home, ".ssh", "id_ed25519"):            false,
		filepath.Join(home, ".aws", "credentials"):           false,
		filepath.Join(home, "finance", "tax.txt"):            false,
		filepath.Join(proj, ".env"):                          false,
		filepath.Join(nomi, "chat", "history.json"):          false,
		filepath.Join(home, "notes", "plain.txt"):            true,
		filepath.Join(proj, ".env.example"):                  true,
		filepath.Join(proj, "src", "main.go"):                true,
		filepath.Join(nomi, "harness", "prompt-images", "a"): true,
	} {
		if got := canRead(spec, p); got != want {
			t.Errorf("read %s = %v, want %v", strings.TrimPrefix(p, tmp), got, want)
		}
	}
	// 按类别授权后能读
	granted := spec
	granted.Granted = map[string]bool{"ssh": true}
	if !canRead(granted, filepath.Join(home, ".ssh", "id_ed25519")) || canRead(granted, filepath.Join(home, ".aws", "credentials")) {
		t.Error("granting ssh opens .ssh only")
	}
	// 单个密钥文件授权：只放开这一个
	if err := os.WriteFile(filepath.Join(proj, "src", ".env"), []byte("s"), 0o600); err != nil {
		t.Fatal(err)
	}
	one := spec
	one.ReadFiles = []string{filepath.Join(proj, ".env")}
	if !canRead(one, filepath.Join(proj, ".env")) || canRead(one, filepath.Join(proj, "src", ".env")) {
		t.Error("a single-file grant opens that file only")
	}
	// 写：项目里可以；计划模式（项目只读）不行；主目录（不在临时目录里）不行
	write := func(s Spec, p string) bool {
		return exec.Command(Exec, "-p", Profile(s), "/bin/sh", "-c", `echo x > "$1"`, "sh", p).Run() == nil
	}
	if !write(spec, filepath.Join(proj, "out.txt")) {
		t.Error("project folder must be writable")
	}
	ro := spec
	ro.CwdWritable = false
	ro.Cwd = proj
	realHome, _ := os.UserHomeDir()
	suffix := "nomi-sbx-probe-" + filepath.Base(tmp)
	realSpec := Spec{Token: "t2", Home: realHome, Cwd: proj, CwdWritable: false}
	// 主目录下的普通文件不行；隐藏的工具目录（如 ~/.ai-usage）可以；凭据、会执行的配置、开机自启不行。
	// 探针都是新文件名，写成了就删掉
	toolDir := filepath.Join(realHome, "."+suffix)
	defer os.RemoveAll(toolDir)
	for p, want := range map[string]bool{
		filepath.Join(realHome, suffix):                            false,
		filepath.Join(realHome, "Documents", suffix):               false,
		filepath.Join(toolDir):                                     true,
		filepath.Join(realHome, ".ssh", suffix):                    false,
		filepath.Join(realHome, ".config", "git", suffix):          false,
		filepath.Join(realHome, "Library", "LaunchAgents", suffix): false,
		filepath.Join(realHome, ".local", "bin", suffix):           false,
		filepath.Join(realHome, ".claude", "hooks", suffix):        false,
	} {
		got := write(realSpec, p)
		if got {
			_ = os.Remove(p)
		}
		if got != want {
			t.Errorf("write %s = %v, want %v", strings.TrimPrefix(p, realHome), got, want)
		}
	}
	if write(realSpec, filepath.Join(realHome, ".claude.json.nomi-probe")) == false {
		t.Error("Claude's config file next to home must stay writable")
	}
	_ = os.Remove(filepath.Join(realHome, ".claude.json.nomi-probe"))
	if write(spec, filepath.Join(home, "finance", "new.txt")) {
		t.Error("protected folder must not be writable even inside temp")
	}
}

// ~/.npmrc、~/.pypirc 照样拒读，但只是包管理器的例行读取：不弹授权请求；项目里的 .npmrc 与别的凭据照常问
func TestRoutineReadIsQuiet(t *testing.T) {
	home := filepath.FromSlash("/Users/u")
	if !RoutineRead(Denial{Rule: "read:cloud", Path: filepath.Join(home, ".npmrc")}, home) {
		t.Fatal("~/.npmrc should be quiet")
	}
	if !RoutineRead(Denial{Rule: "read:cloud", Path: filepath.Join(home, ".pypirc")}, home) {
		t.Fatal("~/.pypirc should be quiet")
	}
	for _, d := range []Denial{
		{Rule: "read:cloud", Path: filepath.Join(home, ".aws/credentials")},
		{Rule: "read:cloud", Path: filepath.Join(home, "proj/.npmrc")},
		{Rule: "write", Path: filepath.Join(home, ".npmrc")},
	} {
		if RoutineRead(d, home) {
			t.Errorf("%+v should still ask", d)
		}
	}
}
