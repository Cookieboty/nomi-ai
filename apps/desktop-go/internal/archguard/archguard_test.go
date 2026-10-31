// Package archguard 用静态扫描守住 Go 版的分层边界，与 Node 版的 ESLint 边界规则对等
// （docs/design/core-host-decoupling.md §3.2、§7.2、§11.1）：
//
//  1. Wails 框架（github.com/wailsapp/wails/v3/...）只能出现在壳层 internal/shell/wailsshell，
//     业务内核（core / gateway / ai / contract / procs / clisdk ...）一律不得依赖宿主框架；
//  2. 壳层包 internal/shell/wailsshell 只能由仓库根的组合根（main.go 等 *_wiring.go）接线，
//     internal/ 下任何包都不得 import 它——业务内核只依赖 hostports 端口，不依赖具体壳实现。
//
// 该测试随 `go test ./...` 运行，无需 build tag 或前端产物；用 go/parser 直接解析，
// 因此平台相关文件（*_windows.go / *_darwin.go / *_linux.go）同样受约束。
package archguard_test

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	shellPkgSuffix = "/internal/shell/wailsshell"
	wailsPrefix    = "github.com/wailsapp/wails/v3"
)

type violation struct {
	file string
	imp  string
	msg  string
}

func TestBoundaries(t *testing.T) {
	modRoot := modRoot(t)
	modulePath := readModulePath(t, filepath.Join(modRoot, "go.mod"))
	shellImportPath := modulePath + shellPkgSuffix

	var violations []violation
	internalDir := filepath.Join(modRoot, "internal")

	err := filepath.WalkDir(internalDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		// 与 go/build 一致：忽略 _ / . 开头的目录文件以及 testdata，只扫描真正参与构建的源码
		if strings.HasPrefix(name, "_") || strings.HasPrefix(name, ".") || name == "testdata" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}

		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}

		rel, err := filepath.Rel(modRoot, filepath.Dir(path))
		if err != nil {
			t.Fatal(err)
		}
		relDir := filepath.ToSlash(rel)
		inShell := strings.HasPrefix(relDir, "internal/shell/wailsshell")

		for _, spec := range file.Imports {
			imp := strings.Trim(spec.Path.Value, `"`)

			if strings.HasPrefix(imp, wailsPrefix) && !inShell {
				violations = append(violations, violation{
					file: rel, imp: imp,
					msg: "业务内核不能依赖 Wails 框架：平台能力走 hostports 端口，宿主实现放 internal/shell/wailsshell（§3.2、§7.2）",
				})
			}

			if (imp == shellImportPath || strings.HasPrefix(imp, shellImportPath+"/")) &&
				!inShell && strings.HasPrefix(relDir, "internal/") {
				violations = append(violations, violation{
					file: rel, imp: imp,
					msg: "internal/ 下的包不能依赖壳层 wailsshell：只能由仓库根组合根接线，业务内核依赖 hostports 端口（§3.2、§6）",
				})
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk internal: %v", err)
	}

	for _, v := range violations {
		t.Errorf("%s 导入 %s：%s", v.file, v.imp, v.msg)
	}
}

func modRoot(t *testing.T) string {
	t.Helper()
	// 本文件位于 <modRoot>/internal/archguard/
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件路径")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(self), "..", ".."))
}

func readModulePath(t *testing.T, goMod string) string {
	t.Helper()
	b, err := os.ReadFile(goMod)
	if err != nil {
		t.Fatalf("读 go.mod: %v", err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "module ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "module"))
		}
	}
	t.Fatal("go.mod 里找不到 module 路径")
	return ""
}
