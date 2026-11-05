package cli

// dsh 的配置补丁：dshHomePath / dshPatchPath / repairDshPatchFile。

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DshHomePath = dshHomePath：DSH_HOME（去空白后解析成绝对路径）或 ~/.dsh
func DshHomePath(home string) string {
	if v := util.JSTrim(os.Getenv("DSH_HOME")); v != "" {
		if abs, err := filepath.Abs(v); err == nil {
			return abs
		}
		return v
	}
	return filepath.Join(home, ".dsh")
}

// DshPatchPath = dshPatchPath：dsh 的叠加配置 cordis.patch.yml
func DshPatchPath(home string) string { return filepath.Join(DshHomePath(home), "cordis.patch.yml") }

var crlfSplit = regexp.MustCompile(`\r?\n`)

// RepairDshPatchFile = repairDshPatchFile：修复只剩空白 / 注释的 cordis.patch.yml。dsh 要求顶层是 YAML 数组，
// 空文件会让它启动即退出（`patches … must be a top-level YAML array`）；旧版本移除 Nomi 区块后会留下空文件，
// 没有 Nomi 标记就再也不会被改写，所以每次启动 dsh 前检查一次。原有注释保留，末尾补 `[]`。
// 返回是否改写了；文件不存在、内容有效或写不进去都返回 false。
func RepairDshPatchFile(file string) bool {
	b, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	raw := string(b)
	for _, l := range crlfSplit.Split(raw, -1) {
		t := util.JSTrim(l)
		if t != "" && !strings.HasPrefix(t, "#") {
			return false
		}
	}
	out := "[]\n"
	if util.JSTrim(raw) != "" {
		out = util.JSTrimEnd(raw) + "\n" + out
	}
	// writeFileSync 默认 0o666（受 umask），已存在的文件保留原权限
	if err := os.WriteFile(file, []byte(out), 0o666); err != nil {
		return false
	}
	return true
}
