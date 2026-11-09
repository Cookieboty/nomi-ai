package builtin

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/repotest"
)

// hardcodedAllow：允许出现内置 CLI 名单的地方（文件 → 那一行里的片段 → 原因）。这些不是「每加一个助手都要登记」
// 的名单，而是某几个 CLI 各自的实现（额度查询、日志解析……）；新加的内置助手要用其中的能力时，在那里补实现。
var hardcodedAllow = map[string]map[string]string{
	"internal/core/usage/usageservice.go": {
		"QuotaPlaceholder{{ID: \"claude\"":                                   "额度面板的占位：只有实现了额度查询的才有",
		"range []string{\"claude\", \"codex\", \"dsh\", \"grok\", \"nomi\"}": "各自实现的额度来源",
	},
	"internal/core/usage/logparsers.go": {
		"var LogSources": "能读用量日志的工具（含不是内置助手的），每个都有自己的解析",
	},
	"internal/core/chatassets/chatassets.go": {
		"var Sources": "对话素材的来源（含不是内置助手的）",
	},
	"internal/core/cli/harness/orchestrator.go": {
		"if b == \"claude\" || b == \"codex\" || b == \"grok\" || b == \"dsh\"": "斜杠命令转发：这几个各有转发实现",
	},
}

var builtinLit = regexp.MustCompile(`"(` + strings.Join(IDs, "|") + `)"`)

// lineID：分成多行、每行一个 id 的名单（切片元素、map 键）
var lineID = regexp.MustCompile(`^\s*"(` + strings.Join(IDs, "|") + `)"\s*[:,]`)

// multilineAllow：有意按 CLI 分行写的（各自的实现）
var multilineAllow = map[string]string{
	"internal/core/gwstore/agents/agents.go": "STRIP：五个 CLI 各自网关启动要去掉的环境变量",
}

// 内置 CLI 的名单只在注册表里：插件包以外不再写 3 个及以上内置 id 的列表（加一个内置助手不用到处登记）
func TestNoHardcodedBuiltinLists(t *testing.T) {
	root := repotest.RepoPath("apps/desktop-go")
	var bad []string
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			switch rel {
			case "internal/cliplugins", "internal/contract/gen", "node_modules", "build", "bin":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(rel, ".go") || strings.HasSuffix(rel, "_test.go") {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		n := 0
		var run []string
		start := 0
		flush := func() {
			seen := map[string]bool{}
			for _, x := range run {
				seen[x] = true
			}
			if len(seen) >= 3 && multilineAllow[rel] == "" {
				bad = append(bad, rel+":"+itoa(start)+": "+strings.Join(run, ", ")+"（分行的名单）")
			}
			run = nil
		}
		for sc.Scan() {
			n++
			line := sc.Text()
			if m := lineID.FindStringSubmatch(line); m != nil {
				if len(run) == 0 {
					start = n
				}
				run = append(run, m[1])
			} else {
				flush()
			}
			seen := map[string]bool{}
			for _, m := range builtinLit.FindAllStringSubmatch(line, -1) {
				seen[m[1]] = true
			}
			if len(seen) < 3 {
				continue
			}
			allowed := false
			for frag := range hardcodedAllow[rel] {
				if strings.Contains(line, frag) {
					allowed = true
					break
				}
			}
			if !allowed {
				bad = append(bad, rel+":"+itoa(n)+": "+strings.TrimSpace(line))
			}
		}
		flush()
		return nil
	})
	if len(bad) > 0 {
		t.Fatalf("内置 CLI 名单要从 builtin 注册表取（builtin.Ordered / builtin.Where / builtin.Get），不要写死：\n%s",
			strings.Join(bad, "\n"))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for ; n > 0; n /= 10 {
		s = string(rune('0'+n%10)) + s
	}
	return s
}
