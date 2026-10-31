package harness

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// fieldAccessors 登记 Node 版「公开字段」→ Go 版「导出方法」的语言形态差异。
// TS 没有 partial class、字段直接公开；Go 端以方法暴露。只允许这类平台强制差异，
// 新增条目意味着双端表面不再 1:1，必须在评审中显式说明（shrink-only：能删不能随便加）。
var fieldAccessors = map[string]string{
	"events": "Events",
}

var (
	structClassRe = regexp.MustCompile(`export class HarnessOrchestrator`)
	// 类体内两空格缩进的公开方法：可选 async/public 修饰，名字后紧跟 ( 或泛型 <。
	structMethodRe = regexp.MustCompile(`^  (?:public |async |public async |override )*([A-Za-z_$][\w$]*)\s*[(<]`)
	// 类体内两空格缩进的公开字段：readonly/public 修饰，名字后是 = / ?: / !:。
	structFieldRe = regexp.MustCompile(`^  (?:readonly |public |declare |abstract )*([A-Za-z_$][\w$]*)\s*(?:!|\??:)?\s*=`)
)

func structControlWords() map[string]bool {
	return map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true, "return": true, "constructor": true}
}

// pascal 与 TS camelCase → Go PascalCase 的导出命名约定对齐。
func pascal(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// collectGoOrchestratorMethods 用 AST 采集本包所有非测试生产文件里 receiver 为 *Orchestrator 的导出方法。
func collectGoOrchestratorMethods(t *testing.T) map[string]bool {
	t.Helper()
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("parse harness package: %v", err)
	}
	out := map[string]bool{}
	for _, pkg := range pkgs {
		for _, file := range pkg.Files {
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Recv == nil || !fn.Name.IsExported() {
					continue
				}
				if len(fn.Recv.List) != 1 {
					continue
				}
				star, ok := fn.Recv.List[0].Type.(*ast.StarExpr)
				if !ok {
					continue
				}
				if id, ok := star.X.(*ast.Ident); ok && id.Name == "Orchestrator" {
					out[fn.Name.Name] = true
				}
			}
		}
	}
	return out
}

// collectNodeSurface 解析 Orchestrator.ts，返回类体内的公开方法名与公开字段名。
func collectNodeSurface(t *testing.T) (methods, fields map[string]bool) {
	t.Helper()
	p := paritytest.RepoPath("apps", "desktop-electron", "internal", "core", "src", "cli", "harness", "Orchestrator.ts")
	b, err := os.ReadFile(p)
	if err != nil {
		paritytest.SkipOrFail(t, "Node Orchestrator.ts source tree required:", filepath.ToSlash(p))
		return nil, nil
	}
	methods = map[string]bool{}
	fields = map[string]bool{}
	control := structControlWords()
	inClass := false
	for _, line := range strings.Split(string(b), "\n") {
		if !inClass {
			if structClassRe.MatchString(line) {
				inClass = true
			}
			continue
		}
		if strings.HasPrefix(line, "}") {
			break
		}
		if m := structMethodRe.FindStringSubmatch(line); m != nil {
			name := m[1]
			if !control[name] && !strings.HasPrefix(line, "   ") {
				methods[name] = true
			}
			continue
		}
		if m := structFieldRe.FindStringSubmatch(line); m != nil {
			name := m[1]
			if !control[name] {
				fields[name] = true
			}
		}
	}
	return methods, fields
}

// TestOrchestratorStructParity 守住 Node HarnessOrchestrator 与 Go Orchestrator 的公开表面 1:1：
// Node 每个公开方法在 Go 端必须有同名 PascalCase 方法；公开字段只能经 fieldAccessors 登记的方法暴露。
// Go 端也不得冒出 Node 表面之外的导出方法。防止双端逐行移植时悄悄漏方法 / 加方法（docs/design/migrate-2.0.5-go.md §3.2）。
func TestOrchestratorStructParity(t *testing.T) {
	goMethods := collectGoOrchestratorMethods(t)
	nodeMethods, nodeFields := collectNodeSurface(t)
	if nodeMethods == nil {
		return
	}

	var missing []string
	for name := range nodeMethods {
		if !goMethods[pascal(name)] {
			missing = append(missing, name)
		}
	}

	var unmappedFields []string
	accessorUsed := map[string]bool{}
	for name := range nodeFields {
		acc, ok := fieldAccessors[name]
		if !ok {
			unmappedFields = append(unmappedFields, name)
			continue
		}
		if !goMethods[acc] {
			missing = append(missing, name+"(field→"+acc+")")
			continue
		}
		accessorUsed[acc] = true
	}

	var extra []string
	for name := range goMethods {
		camel := strings.ToLower(name[:1]) + name[1:]
		if nodeMethods[camel] || accessorUsed[name] {
			continue
		}
		extra = append(extra, name)
	}

	sort.Strings(missing)
	sort.Strings(unmappedFields)
	sort.Strings(extra)
	if len(missing) > 0 {
		t.Errorf("Go Orchestrator 缺少 Node 公开表面（%d）：%s", len(missing), strings.Join(missing, ", "))
	}
	if len(unmappedFields) > 0 {
		t.Errorf("Node 公开字段未在 fieldAccessors 登记形态映射（%d）：%s", len(unmappedFields), strings.Join(unmappedFields, ", "))
	}
	if len(extra) > 0 {
		t.Errorf("Go Orchestrator 多出 Node 表面之外的导出方法（%d）：%s", len(extra), strings.Join(extra, ", "))
	}
}
