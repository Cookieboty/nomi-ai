package shellhandlers_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/theme"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
)

// 调一个过程，返回线上编码后的结果帧（与视图收到的一致）
func call(t *testing.T, s *contract.Session, ch chan contract.ServerFrame, name, input string) map[string]json.RawMessage {
	t.Helper()
	req := `{"t":"req","id":"1","kind":"call","name":"` + name + `"`
	if input != "" {
		req += `,"input":` + input
	}
	s.Handle([]byte(req + "}"))
	select {
	case f := <-ch:
		b, _ := contract.EncodeWire(f)
		var m map[string]json.RawMessage
		_ = json.Unmarshal(b, &m)
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
		return nil
	}
}

func TestCustomThemeDialogs(t *testing.T) {
	dir := t.TempDir()
	saved := ""
	r := contract.NewRouter()
	shellhandlers.Install(shellhandlers.Deps{
		UserData: dir, Router: r, SystemLangs: []string{"zh-CN"},
		ThemeDialogs: shellhandlers.ThemeDialogs{
			PickFile: func(string, string, []string) (string, error) { return "", nil }, // 取消
			SaveFile: func(_, name, _ string, _ []string) (string, error) {
				if saved == "" {
					return "", nil
				}
				return filepath.Join(saved, name), nil
			},
		},
	})
	procs.Install(r)
	ch := make(chan contract.ServerFrame, 8)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()

	// 取消选择 / 保存：结果是 null（不是缺字段），视图的 nullable 校验才过得去
	for _, name := range []string{"theme.customImport", "theme.customPickBackground", "theme.customTemplate"} {
		f := call(t, s, ch, name, "")
		if string(f["t"]) != `"res"` || string(f["output"]) != "null" {
			t.Errorf("%s cancel: %s / output=%s", name, f["t"], f["output"])
		}
	}

	// 下载模板：写出的文件能原样再导入（拖进来的字节）
	saved = dir
	f := call(t, s, ch, "theme.customTemplate", "")
	var path string
	_ = json.Unmarshal(f["output"], &path)
	raw, err := os.ReadFile(path)
	if err != nil || !strings.HasSuffix(path, theme.PackExt) {
		t.Fatalf("template: %q %v", path, err)
	}
	in := `{"data":{"$u8":"` + base64.StdEncoding.EncodeToString(raw) + `"}}`
	f = call(t, s, ch, "theme.customImportData", in)
	var c theme.Custom
	_ = json.Unmarshal(f["output"], &c)
	if string(f["t"]) != `"res"` || c.ID == "" || !c.Adaptive() || c.Name["zh"] != "我的主题" {
		t.Fatalf("import template: %s %+v", f["t"], c)
	}

	// 不是主题包：统一文案
	bad := `{"data":{"$u8":"` + base64.StdEncoding.EncodeToString([]byte("hello")) + `"}}`
	f = call(t, s, ch, "theme.customImportData", bad)
	if string(f["t"]) != `"err"` || !strings.Contains(string(f["error"]), "BAD_INPUT") {
		t.Fatalf("bad pack: %s %s", f["t"], f["error"])
	}
}
