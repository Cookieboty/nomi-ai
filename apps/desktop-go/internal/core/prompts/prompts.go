// Package prompts：内核发给模型的整段提示词，一个提示词一个文件（text/*.md），和代码分开改。
//
//   - text/<name>.md：固定语言的提示词；
//   - text/zh/<name>.md、text/en/<name>.md：跟着界面语言走的（日程、对话要求）。
//
// 文件是 text/template 模板（{{.Field}}、{{if}}），末尾的一个换行不算内容。
// 放进来的是说明与要求；把数据包起来的标签（<conversation>、[1] 来源……）、工具的说明与参数说明留在代码旁边。
// 每个提示词拼出来的结果由 golden_test.go 的快照钉住：改完跑 `go test ./internal/core/prompts -update`，在 diff 里核对。
package prompts

import (
	"embed"
	"io/fs"
	"log"
	"strings"
	"text/template"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

//go:embed text
var files embed.FS

var tpls = func() map[string]*template.Template {
	out := map[string]*template.Template{}
	funcs := template.FuncMap{"join": strings.Join}
	err := fs.WalkDir(files, "text", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".md") {
			return err
		}
		b, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(strings.TrimPrefix(p, "text/"), ".md")
		t, err := template.New(name).Funcs(funcs).Option("missingkey=error").Parse(strings.TrimSuffix(string(b), "\n"))
		if err != nil {
			return err
		}
		out[name] = t
		return nil
	})
	if err != nil {
		panic("prompts: " + err.Error())
	}
	return out
}()

// Render：按 data 填好 text/<name>.md
func Render(name string, data any) string {
	t := tpls[name]
	if t == nil {
		panic("prompts: no prompt " + name)
	}
	var b strings.Builder
	if err := t.Execute(&b, data); err != nil {
		log.Printf("[prompts] %s: %v", name, err)
	}
	return b.String()
}

// Text：不带参数的 text/<name>.md
func Text(name string) string { return Render(name, nil) }

// Local：当前界面语言的 text/<zh|en>/<name>.md
func Local(name string, data any) string {
	lang := "zh"
	if i18n.Locale() == "en" {
		lang = "en"
	}
	return Render(lang+"/"+name, data)
}

// Names：所有提示词（测试用）
func Names() []string {
	out := make([]string, 0, len(tpls))
	for n := range tpls {
		out = append(out, n)
	}
	return out
}
