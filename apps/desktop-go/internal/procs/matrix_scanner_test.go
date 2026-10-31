package procs

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// parseSrc 把一段 Go 源码解析成 AST（不做类型检查，语法合法即可）。
func parseSrc(t *testing.T, src string) *ast.File {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "probe.go", src, 0)
	if err != nil {
		t.Fatalf("探针源码解析失败：%v\n%s", err, src)
	}
	return file
}

// scanSrcs 用给定包索引扫描若干「文件」，返回被判定为已实现的名字集合。
func scanSrcs(t *testing.T, p *pkgData, srcs ...string) map[string]bool {
	t.Helper()
	got := map[string]bool{}
	mark := func(name string) { got[name] = true }
	for _, src := range srcs {
		file := parseSrc(t, src)
		scanFile(file, p, mark)
	}
	return got
}

func TestMatrixScannerRegistrationContexts(t *testing.T) {
	// 用契约里真实存在的过程名做探针，确保 mark 不会被非注册语境骗过。
	p := &pkgData{
		mapKeys:   map[string][]string{"procs": {"ai.sessions.list"}},
		sliceVals: map[string][]string{},
		retKeys: map[string][]string{
			// Handlers() 直接 return 一个 map 字面量（对齐 knowledgehandlers）。
			"Handlers": {"kb.search"},
		},
	}

	real := scanSrcs(t, p,
		// 1) 直接注册
		`package probe
func f(r *Router) { r.Call("agents.scan", nil); r.Stream("voice.streamStart", nil) }`,

		// 2) 局部闭包包装 + 嵌套包装（report 体内调 call）
		`package probe
func g(r *Router) {
	call := func(name string, f func()) { r.Call(name, nil) }
	report := func(name string) { call(name, nil) }
	call("desktop.state", nil)
	report("mascot.report", nil)
}`,

		// 3a) 包级 map 变量 range 注册
		`package probe
func h(r *Router) {
	for name := range procs {
		name := name
		r.Call(name, nil)
	}
}`,

		// 3b) hs := Handlers(sv) 后 range（retKeys 提供 map 键）
		`package probe
func i(r *Router) {
	hs := Handlers(nil)
	for name, h := range hs {
		h := h
		r.Call(name, nil)
	}
}`,

		// 4) 前缀拼接注册（对齐 airouter）
		`package probe
func j(r *Router) {
	for _, m := range []string{"stream"} {
		m := m
		r.Stream("ai.chat."+m, nil)
	}
}`,
	)

	wantImpl := []string{
		"agents.scan", "voice.streamStart",
		"desktop.state", "mascot.report",
		"ai.sessions.list", "kb.search",
		"ai.chat.stream",
	}
	for _, name := range wantImpl {
		if !real[name] {
			t.Errorf("真实注册未被识别：%s", name)
		}
	}
}

func TestMatrixScannerIgnoresNonRegistrationStrings(t *testing.T) {
	// 这些名字只出现在注释 / 错误消息 / 普通字符串 / 非注册函数调用里，绝不能算实现。
	p := &pkgData{
		mapKeys:   map[string][]string{},
		sliceVals: map[string][]string{},
		retKeys:   map[string][]string{},
	}
	src := `package probe

// agents.scan 只是注释
func f() error {
	_ = "desktop.state"
	msg := "desktop.grant 出现在普通变量里"
	return errf("kb.search 出现在错误消息里：%s", msg)
}

func errf(f string, a ...any) error { return nil }

func g() {
	// 普通函数调用的字符串实参，不是 r.Call/Stream
	println("agents.state")
	emit("mascot.report")
}

func emit(string) {}
`
	got := scanSrcs(t, p, src)
	falsePositives := []string{
		"agents.scan", "desktop.state", "desktop.grant",
		"kb.search", "agents.state", "mascot.report",
	}
	for _, name := range falsePositives {
		if got[name] {
			t.Errorf("非注册语境被误判为已实现（假实现骗过护栏）：%s", name)
		}
	}
}
