package tr

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestDictionaryCopiesMatchPackages(t *testing.T) {
	for _, lang := range []string{"en", "zh"} {
		src, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "..", "packages", "i18n", "src", "locales", lang, "electron", "common.json"))
		if err != nil {
			t.Fatal(err)
		}
		mine, _ := os.ReadFile(filepath.Join("locales", lang, "common.json"))
		if !bytes.Equal(src, mine) {
			t.Fatalf("%s/common.json 与 packages/i18n 不一致：重新复制", lang)
		}
	}
}

func TestT(t *testing.T) {
	SetLocale(func() string { return "zh-CN" })
	defer SetLocale(nil)
	if got := T("electron.common.protected-folder", ".ssh"); got == "electron.common.protected-folder" || !bytes.Contains([]byte(got), []byte(".ssh")) {
		t.Fatal(got)
	}
	if T("nope {0}", 1) != "nope 1" || T("x {1}", "a") != "x {1}" {
		t.Fatal("format")
	}
	if Format("{a}-{b}", []any{map[string]any{"a": 1.5}}) != "1.5-{b}" {
		t.Fatal("named")
	}
}
