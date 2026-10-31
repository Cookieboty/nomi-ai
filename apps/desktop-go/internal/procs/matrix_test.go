package procs

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract/gen"
)

var updateMatrix = flag.Bool("update", false, "更新 testdata/capability_matrix.txt 能力矩阵基线")

// matrixPath 是 Go 端契约过程能力矩阵（兼作 stub shrink-only 基线）。
const matrixPath = "testdata/capability_matrix.txt"

// pkgData 是一个目录（一个 Go package）的静态索引：AST 文件集合、包级 map/slice
// 字面量集合、函数直接 return 的 map 键集合，以及包级注册包装函数。
type pkgData struct {
	files     []*ast.File
	mapKeys   map[string][]string // var 名 → map 字面量的字符串键
	sliceVals map[string][]string // var 名 → slice 字面量的字符串元素
	retKeys   map[string][]string // 函数名 → 函数体里 return 的 map 字面量字符串键
	pkgWrap   map[string]int      // 包级包装函数名 → 过程名形参的扁平位置
}

// implementedProcs 静态采集 Go 端「真正注册了处理器」的契约过程名。
//
// 只承认「注册语境」里出现的过程名，注释、错误消息、日志、zod 错误里的过程名
// 不会被误判。覆盖仓库里全部四种注册风格：
//  1. 直接注册：r.Call/Stream("name", …)；
//  2. 包装函数：reg/in/gil/plain/call 这类「体内调 r.Call(name, …)」的函数，
//     调用点 reg("name", …)（含 report→call 这种嵌套包装，做不动点求解；
//     gil/plain 定义在 coding.go、agents.go 等同包文件也能识别）；
//  3. map 键循环：for name := range procs { r.Call(name, …) }（aifacade / knowledge）；
//  4. 前缀拼接：r.Stream("ai.chat."+m, …)，m 来自 range []string{…}（airouter）。
//
// 只认与生成表 gen.Procedures 完全相等的名字。生成物（contract/gen）、测试、
// testdata 与 stubs.go 自身一律排除：那里出现的名字只代表「契约里有这个过程」，
// 不代表 Go 端实现了它。
func implementedProcs(t *testing.T) map[string]bool {
	t.Helper()
	contractNames := make(map[string]bool, len(gen.Procedures))
	for _, p := range gen.Procedures {
		contractNames[p.Name] = true
	}
	impl := map[string]bool{}
	mark := func(name string) {
		if contractNames[name] {
			impl[name] = true
		}
	}

	root := repoRoot(t)
	pkgs := map[string]*pkgData{}
	var order []string
	pkgOf := func(dir string) *pkgData {
		p := pkgs[dir]
		if p == nil {
			p = &pkgData{
				mapKeys:   map[string][]string{},
				sliceVals: map[string][]string{},
				retKeys:   map[string][]string{},
			}
			pkgs[dir] = p
			order = append(order, dir)
		}
		return p
	}

	skipPath := func(path string) bool {
		if strings.HasSuffix(path, "_test.go") || filepath.Base(path) == "stubs.go" {
			return true
		}
		normalized := filepath.ToSlash(path)
		return strings.Contains(normalized, "/testdata/") ||
			strings.Contains(normalized, "/internal/contract/gen/")
	}
	accept := func(path string) {
		if skipPath(path) {
			return
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("解析 %s 失败：%v", path, err)
		}
		p := pkgOf(filepath.Dir(path))
		p.files = append(p.files, file)
		indexPackage(p, file)
	}

	if err := filepath.WalkDir(filepath.Join(root, "internal"), func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if name == "testdata" || strings.HasPrefix(name, "_") || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(name, ".go") {
			accept(p)
		}
		return nil
	}); err != nil {
		t.Fatalf("遍历 internal：%v", err)
	}
	// 仓库根组合根（main.go / *_wiring.go）里也可能直接注册
	if entries, err := os.ReadDir(root); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".go") {
				accept(filepath.Join(root, e.Name()))
			}
		}
	}

	for _, dir := range order {
		p := pkgs[dir]
		p.pkgWrap = solvePkgWrappers(p.files)
		for _, file := range p.files {
			scanFile(file, p, mark)
		}
	}
	return impl
}

// indexPackage 收集包级 var map/slice 字面量与函数直接 return 的 map 字面量键。
func indexPackage(p *pkgData, file *ast.File) {
	for _, decl := range file.Decls {
		if gd, ok := decl.(*ast.GenDecl); ok && gd.Tok == token.VAR {
			for _, spec := range gd.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, value := range vs.Values {
					if i >= len(vs.Names) {
						break
					}
					name := vs.Names[i].Name
					if keys, ok := mapStringKeys(value); ok {
						p.mapKeys[name] = append(p.mapKeys[name], keys...)
					}
					if vals, ok := sliceStringVals(value); ok {
						p.sliceVals[name] = append(p.sliceVals[name], vals...)
					}
				}
			}
		}
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Body == nil {
			continue
		}
		var keys []string
		ast.Inspect(fd.Body, func(n ast.Node) bool {
			rs, ok := n.(*ast.ReturnStmt)
			if !ok {
				return true
			}
			for _, res := range rs.Results {
				if ks, ok := mapStringKeys(res); ok {
					keys = append(keys, ks...)
				}
			}
			return true
		})
		if len(keys) > 0 {
			p.retKeys[fd.Name.Name] = append(p.retKeys[fd.Name.Name], keys...)
		}
	}
}

// solvePkgWrappers 在整个包的文件集合上不动点求解包级注册包装函数
// （gil/plain 与调用它们的其它包级函数）。
func solvePkgWrappers(files []*ast.File) map[string]int {
	type decl struct {
		name string
		ft   *ast.FuncType
		body *ast.BlockStmt
	}
	var decls []decl
	for _, file := range files {
		for _, d := range file.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok && fd.Body != nil {
				decls = append(decls, decl{fd.Name.Name, fd.Type, fd.Body})
			}
		}
	}
	wrappers := map[string]int{}
	changed := true
	for changed {
		changed = false
		for _, d := range decls {
			if _, exists := wrappers[d.name]; exists {
				continue
			}
			if pos, ok := wrapperNameParam(d.ft, d.body, wrappers); ok {
				wrappers[d.name] = pos
				changed = true
			}
		}
	}
	return wrappers
}

// mapStringKeys：表达式是 map 字面量时返回其字符串键。
func mapStringKeys(e ast.Expr) ([]string, bool) {
	cl, ok := e.(*ast.CompositeLit)
	if !ok {
		return nil, false
	}
	if _, ok := cl.Type.(*ast.MapType); !ok {
		return nil, false
	}
	var keys []string
	for _, el := range cl.Elts {
		kv, ok := el.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		if v, ok := stringLit(kv.Key); ok {
			keys = append(keys, v)
		}
	}
	return keys, len(keys) > 0
}

// sliceStringVals：表达式是 []string{…} 字面量时返回其字符串元素。
func sliceStringVals(e ast.Expr) ([]string, bool) {
	cl, ok := e.(*ast.CompositeLit)
	if !ok {
		return nil, false
	}
	var vals []string
	for _, el := range cl.Elts {
		if v, ok := stringLit(el); ok {
			vals = append(vals, v)
		}
	}
	return vals, len(vals) > 0
}

func stringLit(e ast.Expr) (string, bool) {
	bl, ok := e.(*ast.BasicLit)
	if !ok || bl.Kind != token.STRING {
		return "", false
	}
	v, err := strconv.Unquote(bl.Value)
	if err != nil {
		return "", false
	}
	return v, true
}

// scanFile 采集单个文件里注册语境中的过程名。
func scanFile(file *ast.File, p *pkgData, mark func(string)) {
	// range 绑定：range 变量名 → 可静态枚举的字符串集合（map 键或 slice 元素）。
	binds := map[string][]string{}
	localMapVars := map[string][]string{}
	localSliceVars := map[string][]string{}
	localCallVars := map[string]string{} // 局部变量 → 被调函数名（hs := Handlers(sv)）

	callFn := func(x ast.Expr) (string, bool) {
		if call, ok := x.(*ast.CallExpr); ok {
			if id, ok := call.Fun.(*ast.Ident); ok {
				return id.Name, true
			}
		}
		return "", false
	}
	isMapCollection := func(x ast.Expr) bool {
		switch e := x.(type) {
		case *ast.CompositeLit:
			_, ok := mapStringKeys(e)
			return ok
		case *ast.Ident:
			if _, ok := localMapVars[e.Name]; ok {
				return true
			}
			if _, ok := p.mapKeys[e.Name]; ok {
				return true
			}
			if fn, ok := localCallVars[e.Name]; ok {
				_, isMap := p.retKeys[fn]
				return isMap
			}
		case *ast.CallExpr:
			if id, ok := e.Fun.(*ast.Ident); ok {
				_, isMap := p.retKeys[id.Name]
				return isMap
			}
		}
		return false
	}
	resolveCollection := func(x ast.Expr) []string {
		switch e := x.(type) {
		case *ast.CompositeLit:
			if keys, ok := mapStringKeys(e); ok {
				return keys
			}
			if vals, ok := sliceStringVals(e); ok {
				return vals
			}
		case *ast.Ident:
			if keys, ok := localMapVars[e.Name]; ok {
				return keys
			}
			if vals, ok := localSliceVars[e.Name]; ok {
				return vals
			}
			if keys, ok := p.mapKeys[e.Name]; ok {
				return keys
			}
			if vals, ok := p.sliceVals[e.Name]; ok {
				return vals
			}
			if fn, ok := localCallVars[e.Name]; ok {
				if keys, ok := p.retKeys[fn]; ok {
					return keys
				}
			}
		case *ast.CallExpr:
			// 直接 range Handlers(sv) —— 解析被调函数直接 return 的 map 键。
			if id, ok := e.Fun.(*ast.Ident); ok {
				if keys, ok := p.retKeys[id.Name]; ok {
					return keys
				}
			}
		}
		return nil
	}

	// 收集局部 map/slice/函数调用变量与 range 绑定。
	ast.Inspect(file, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.AssignStmt:
			for i, rhs := range x.Rhs {
				if i >= len(x.Lhs) {
					break
				}
				id, ok := x.Lhs[i].(*ast.Ident)
				if !ok {
					continue
				}
				if keys, ok := mapStringKeys(rhs); ok {
					localMapVars[id.Name] = append(localMapVars[id.Name], keys...)
				}
				if vals, ok := sliceStringVals(rhs); ok {
					localSliceVars[id.Name] = append(localSliceVars[id.Name], vals...)
				}
				if fn, ok := callFn(rhs); ok {
					localCallVars[id.Name] = fn
				}
			}
		case *ast.RangeStmt:
			vals := resolveCollection(x.X)
			if len(vals) == 0 {
				return true
			}
			// map 的 range：键在 key 位；slice 的 range：元素在 value 位。
			if isMapCollection(x.X) {
				if id, ok := x.Key.(*ast.Ident); ok {
					binds[id.Name] = append(binds[id.Name], vals...)
				}
			} else if id, ok := x.Value.(*ast.Ident); ok {
				binds[id.Name] = append(binds[id.Name], vals...)
			}
		}
		return true
	})

	// evalNameExpr 求值注册名实参：字面量、range 绑定变量、二者的拼接（笛卡尔展开）。
	// 返回 (names, ok)；遇到无法静态解析的标识符时 ok=false，宁漏勿错（漏判会让
	// 该过程落进 STUB，测试立刻红；错判会让假实现蒙混过关）。
	var evalNameExpr func(ast.Expr) ([]string, bool)
	evalNameExpr = func(e ast.Expr) ([]string, bool) {
		switch v := e.(type) {
		case *ast.BasicLit:
			s, ok := stringLit(v)
			if !ok {
				return nil, false
			}
			return []string{s}, true
		case *ast.Ident:
			if vals, ok := binds[v.Name]; ok {
				return vals, true
			}
			return nil, false
		case *ast.BinaryExpr:
			if v.Op != token.ADD {
				return nil, false
			}
			lx, ok := evalNameExpr(v.X)
			if !ok {
				return nil, false
			}
			rx, ok := evalNameExpr(v.Y)
			if !ok {
				return nil, false
			}
			var out []string
			for _, l := range lx {
				for _, r := range rx {
					out = append(out, l+r)
				}
			}
			return out, true
		default:
			return nil, false
		}
	}

	// 局部闭包包装（reg/regCtx/in/call/report 等），做不动点以覆盖嵌套包装
	// （report 体内调 call）。包级包装（gil/plain）由 solvePkgWrappers 求解。
	localWrappers := map[string]int{}
	type closure struct {
		name string
		ft   *ast.FuncType
		body *ast.BlockStmt
	}
	var closures []closure
	ast.Inspect(file, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for i, rhs := range as.Rhs {
			if i >= len(as.Lhs) {
				break
			}
			id, ok := as.Lhs[i].(*ast.Ident)
			if !ok {
				continue
			}
			fl, ok := rhs.(*ast.FuncLit)
			if !ok {
				continue
			}
			closures = append(closures, closure{id.Name, fl.Type, fl.Body})
		}
		return true
	})
	changed := true
	for changed {
		changed = false
		for _, c := range closures {
			if _, exists := localWrappers[c.name]; exists {
				continue
			}
			if pos, ok := wrapperNameParam(c.ft, c.body, mergeWrappers(p.pkgWrap, localWrappers)); ok {
				localWrappers[c.name] = pos
				changed = true
			}
		}
	}

	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}
		argIdx := -1
		switch fun := call.Fun.(type) {
		case *ast.SelectorExpr:
			if fun.Sel.Name == "Call" || fun.Sel.Name == "Stream" {
				argIdx = 0
			}
		case *ast.Ident:
			if pos, ok := localWrappers[fun.Name]; ok {
				argIdx = pos
			} else if pos, ok := p.pkgWrap[fun.Name]; ok {
				argIdx = pos
			}
		}
		if argIdx < 0 || argIdx >= len(call.Args) {
			return true
		}
		if names, ok := evalNameExpr(call.Args[argIdx]); ok {
			for _, name := range names {
				mark(name)
			}
		}
		return true
	})
}

func mergeWrappers(a, b map[string]int) map[string]int {
	m := make(map[string]int, len(a)+len(b))
	for k, v := range a {
		m[k] = v
	}
	for k, v := range b {
		m[k] = v
	}
	return m
}

// wrapperNameParam 判断一个函数是否是「注册包装函数」：其体内是否把某个 string
// 形参直接（r.Call/Stream）或间接（调用 known 里的已知包装）送到注册点。
// 返回该形参在参数列表中的扁平位置。known 为已求解的包装名→过程名形参位置。
func wrapperNameParam(ft *ast.FuncType, body *ast.BlockStmt, known map[string]int) (int, bool) {
	if ft == nil || body == nil {
		return 0, false
	}
	type param struct {
		name string
		idx  int
	}
	var params []param
	idx := 0
	if ft.Params != nil {
		for _, field := range ft.Params.List {
			_, isString := field.Type.(*ast.Ident)
			if id, ok := field.Type.(*ast.Ident); ok {
				isString = id.Name == "string"
			}
			for _, n := range field.Names {
				if isString {
					params = append(params, param{n.Name, idx})
				}
				idx++
			}
			if len(field.Names) == 0 {
				idx++
			}
		}
	}
	for _, p := range params {
		found := false
		ast.Inspect(body, func(n ast.Node) bool {
			if found {
				return false
			}
			c, ok := n.(*ast.CallExpr)
			if !ok || len(c.Args) == 0 {
				return true
			}
			check := func(argPos int) {
				id, ok := c.Args[argPos].(*ast.Ident)
				if ok && id.Name == p.name {
					found = true
				}
			}
			switch fun := c.Fun.(type) {
			case *ast.SelectorExpr:
				if fun.Sel.Name == "Call" || fun.Sel.Name == "Stream" {
					check(0)
				}
			case *ast.Ident:
				if pos, ok := known[fun.Name]; ok && pos < len(c.Args) {
					check(pos)
				}
			}
			return true
		})
		if found {
			return p.idx, true
		}
	}
	return 0, false
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件")
	}
	// internal/procs/matrix_test.go → 上两级即模块根
	return filepath.Clean(filepath.Join(filepath.Dir(self), "..", ".."))
}

type matrixRow struct {
	domain string
	name   string
	kind   string
	impl   bool
}

// buildMatrix 按域分组生成稳定有序的矩阵行。
func buildMatrix(impl map[string]bool) []matrixRow {
	rows := make([]matrixRow, 0, len(gen.Procedures))
	for _, p := range gen.Procedures {
		domain := p.Name
		if i := strings.IndexByte(p.Name, '.'); i >= 0 {
			domain = p.Name[:i]
		}
		rows = append(rows, matrixRow{domain: domain, name: p.Name, kind: p.Kind, impl: impl[p.Name]})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].domain != rows[j].domain {
			return rows[i].domain < rows[j].domain
		}
		return rows[i].name < rows[j].name
	})
	return rows
}

func renderMatrix(rows []matrixRow) string {
	var b bytes.Buffer
	fmt.Fprintln(&b, "# Go 端契约过程能力矩阵（由 internal/procs/matrix_test.go 生成并校验，请勿手改）。")
	fmt.Fprintln(&b, "# 列：状态(IMPL=已注册处理器 / STUB=procs.Install 补的 UNAVAILABLE 桩)  kind  过程名。")
	fmt.Fprintln(&b, "# 规则：STUB 集合只减不增（shrink-only）；新增契约过程必须在 Go 端实现，禁止新增桩。")
	fmt.Fprintln(&b, "# 更新：go test ./internal/procs/ -run TestCapabilityMatrix -update")
	implN, stubN := 0, 0
	byDomain := map[string][2]int{} // [impl, stub]
	for _, r := range rows {
		c := byDomain[r.domain]
		if r.impl {
			c[0]++
			implN++
		} else {
			c[1]++
			stubN++
		}
		byDomain[r.domain] = c
	}
	fmt.Fprintf(&b, "# 合计 %d：已实现 %d，桩 %d。\n", len(rows), implN, stubN)

	lastDomain := ""
	for _, r := range rows {
		if r.domain != lastDomain {
			c := byDomain[r.domain]
			fmt.Fprintf(&b, "\n[%s] 已实现 %d / 桩 %d\n", r.domain, c[0], c[1])
			lastDomain = r.domain
		}
		status := "STUB"
		if r.impl {
			status = "IMPL"
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\n", status, r.kind, r.name)
	}
	return b.String()
}

// TestCapabilityMatrix 校验已提交的能力矩阵与生产代码一致；STUB 集合只减不增。
// 新实现一个过程后用 -update 刷新；若新增契约过程却不实现，本测试会失败（出现新的 STUB）。
func TestCapabilityMatrix(t *testing.T) {
	impl := implementedProcs(t)
	rows := buildMatrix(impl)
	want := renderMatrix(rows)

	if *updateMatrix {
		if err := os.MkdirAll(filepath.Dir(matrixPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(matrixPath, []byte(want), 0o644); err != nil {
			t.Fatal(err)
		}
		stubN := 0
		for _, r := range rows {
			if !r.impl {
				stubN++
			}
		}
		t.Logf("能力矩阵已更新：共 %d，已实现 %d，桩 %d", len(rows), len(rows)-stubN, stubN)
		return
	}

	got, err := os.ReadFile(matrixPath)
	if err != nil {
		t.Fatalf("读取能力矩阵失败：%v\n先用 `go test ./internal/procs/ -run TestCapabilityMatrix -update` 生成", err)
	}
	if string(got) != want {
		var newStubs, nowImpl []string
		committed := parseMatrixStubs(t, string(got))
		for _, r := range rows {
			if r.impl {
				if committed[r.name] {
					nowImpl = append(nowImpl, r.name)
				}
				continue
			}
			if !committed[r.name] {
				newStubs = append(newStubs, r.name)
			}
		}
		if len(newStubs) > 0 {
			t.Errorf("出现 %d 个新的未实现过程（STUB 只减不增，必须在 Go 端实现）：\n  %s",
				len(newStubs), strings.Join(newStubs, "\n  "))
		}
		if len(nowImpl) > 0 {
			t.Errorf("有 %d 个过程已实现，请刷新能力矩阵：\n  %s",
				len(nowImpl), strings.Join(nowImpl, "\n  "))
		}
		t.Errorf("能力矩阵与生产代码不一致；确认变更后运行 `go test ./internal/procs/ -run TestCapabilityMatrix -update` 提交 %s", matrixPath)
	}
}

// parseMatrixStubs 从已提交矩阵里解析出 STUB 过程名集合。
func parseMatrixStubs(t *testing.T, content string) map[string]bool {
	t.Helper()
	stubs := map[string]bool{}
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") || strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) != 3 {
			t.Fatalf("矩阵行格式异常：%q", line)
		}
		if fields[0] == "STUB" {
			stubs[fields[2]] = true
		}
	}
	return stubs
}
