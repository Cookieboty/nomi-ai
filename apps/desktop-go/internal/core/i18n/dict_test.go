package i18n

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDictionaryCopiesMatchPackages(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "..", "packages", "i18n", "src", "locales")
	n := 0
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".json") {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		src, _ := os.ReadFile(p)
		mine, err := localesFS.ReadFile("locales/" + filepath.ToSlash(rel))
		if err != nil || !bytes.Equal(src, mine) {
			t.Errorf("%s 与 packages/i18n 不一致：重新复制", rel)
		}
		n++
		return nil
	})
	if err != nil || n == 0 {
		t.Fatal(err, n)
	}
	var embedded int
	_ = fs.WalkDir(localesFS, "locales", func(p string, d fs.DirEntry, _ error) error {
		if !d.IsDir() {
			embedded++
		}
		return nil
	})
	if embedded != n {
		t.Fatalf("embedded %d files, packages has %d", embedded, n)
	}
}

func TestGlobalT(t *testing.T) {
	SetLocale(func() string { return "zh-CN" })
	defer SetLocale(nil)
	if got := T("electron.common.protected-folder", ".ssh"); got == "electron.common.protected-folder" || !strings.Contains(got, ".ssh") {
		t.Fatal(got)
	}
	if T("nope {0}", 1) != "nope 1" || T("x {1}", "a") != "x {1}" || T("n {0}", nil) != "n null" {
		t.Fatal("format")
	}
	if Format("{a}-{b}", []any{map[string]any{"a": 1.5}}) != "1.5-{b}" {
		t.Fatal("named")
	}
	// ui 命名空间也在同一张表里（getDictionary 合并全部命名空间）
	SetLocale(func() string { return "en" })
	if T("ai-runtime.providers.preset-openai") == "ai-runtime.providers.preset-openai" {
		t.Fatal("ai-runtime namespace missing")
	}
}
