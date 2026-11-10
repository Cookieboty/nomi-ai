package sandbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/catalog"
)

// 真跑 sandbox-exec：每个内置 CLI 自己主目录里的技能（及 ~/.agents/skills 这类共享技能目录）都能读、
// 技能里带执行位的脚本能直接跑。沙箱只拦凭据、受保护文件夹与 Nomi 数据，CLI 用自己的技能不该被拦。
// 注意：脚本没有执行位时直接运行报 "permission denied"（EACCES），那是文件权限，与沙箱无关
// （沙箱拒绝是 "operation not permitted"，并会在标签上弹授权请求）。
func TestCLISkillsUsable(t *testing.T) {
	if !Supported() {
		t.Skip("sandbox-exec not available")
	}
	tmp := t.TempDir()
	home := filepath.Join(tmp, "home")
	dirs := append(catalog.HostListAll("homeDirs"), ".agents")
	if len(dirs) < 2 {
		t.Fatalf("no CLI home dirs in the catalog: %v", dirs)
	}
	spec := Spec{
		Token: "skills", Home: home, Cwd: filepath.Join(tmp, "proj"), CwdWritable: true,
		NomiData: filepath.Join(tmp, "nomi"), Granted: map[string]bool{},
	}
	profile := Profile(spec)
	for _, d := range dirs {
		skill := filepath.Join(home, d, "skills", "demo")
		script := filepath.Join(skill, "scripts", "context.sh")
		if err := os.MkdirAll(filepath.Dir(script), 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: demo\n---\n"), 0o644)
		_ = os.WriteFile(script, []byte("#!/bin/sh\necho ran\n"), 0o755)

		if out, err := exec.Command(Exec, "-p", profile, "/bin/cat", filepath.Join(skill, "SKILL.md")).CombinedOutput(); err != nil {
			t.Errorf("~/%s/skills: read SKILL.md denied: %v %s", d, err, out)
		}
		out, err := exec.Command(Exec, "-p", profile, "/bin/sh", "-c", `"$1"`, "sh", script).CombinedOutput()
		if err != nil || !strings.Contains(string(out), "ran") {
			t.Errorf("~/%s/skills: run script denied: %v %s", d, err, out)
		}
	}
}
