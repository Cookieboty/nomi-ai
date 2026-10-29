package clisdk

import (
	"regexp"
	"strings"

	"github.com/dlclark/regexp2"
)

func mustRe(s string) *regexp.Regexp { return regexp.MustCompile(s) }

// JSRegExp = 运行期由数据（manifest / 插件）给出的 JS 正则：用 regexp2 的 ECMAScript 模式（支持前瞻、反向引用）。
type JSRegExp struct{ re *regexp2.Regexp }

// NewJSRegExp = new RegExp(src, flags)，flags 支持 i/m/s/g/u/y（g/y/u 不影响 test/exec 首次匹配）。
func NewJSRegExp(src, flags string) (*JSRegExp, error) {
	var opt regexp2.RegexOptions = regexp2.ECMAScript
	if strings.Contains(flags, "i") {
		opt |= regexp2.IgnoreCase
	}
	if strings.Contains(flags, "m") {
		opt |= regexp2.Multiline
	}
	if strings.Contains(flags, "s") {
		opt &^= regexp2.ECMAScript // regexp2：ECMAScript 与 Singleline 不能同用
		opt |= regexp2.Singleline
	}
	re, err := regexp2.Compile(src, opt)
	if err != nil {
		return nil, err
	}
	return &JSRegExp{re}, nil
}

// Test = re.test(s)。
func (r *JSRegExp) Test(s string) bool {
	ok, _ := r.re.MatchString(s)
	return ok
}

// Exec = re.exec(s)：nil = null；返回各捕获组（未参与 = nil）。
func (r *JSRegExp) Exec(s string) []*string {
	m, _ := r.re.FindStringMatch(s)
	if m == nil {
		return nil
	}
	gs := m.Groups()
	out := make([]*string, len(gs))
	for i, g := range gs {
		if len(g.Captures) > 0 {
			v := g.String()
			out[i] = &v
		}
	}
	return out
}
