package theme_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/theme"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/repotest"
)

// 令牌白名单与 packages/ui/src/themeTokens.ts 一致
func TestThemeableTokensMatchUI(t *testing.T) {
	raw, err := os.ReadFile(repotest.RepoPath("packages/ui/src/themeTokens.ts"))
	if err != nil {
		t.Fatal(err)
	}
	var ui []string
	for _, m := range regexp.MustCompile(`(?m)^\s+'(--cd-[a-z0-9-]+)',$`).FindAllStringSubmatch(string(raw), -1) {
		ui = append(ui, m[1])
	}
	if strings.Join(ui, ",") != strings.Join(theme.ThemeableTokens, ",") {
		t.Fatalf("tokens.go 与 themeTokens.ts 不一致：\nui: %v\ngo: %v", ui, theme.ThemeableTokens)
	}
}

func pack(t *testing.T, over map[string]any) []byte {
	t.Helper()
	p := map[string]any{
		"format": 1,
		"name":   map[string]string{"zh": "深海", "en": "Deep Sea"},
		"base":   "dark",
		"seeds":  map[string]string{"accent": "#4FA3D9", "background": "#0f1a22"},
		"tokens": map[string]string{"--cd-color-success": "rgb(63, 180, 122)"},
	}
	for k, v := range over {
		if v == nil {
			delete(p, k)
		} else {
			p[k] = v
		}
	}
	b, _ := json.Marshal(p)
	return b
}

func TestParsePack(t *testing.T) {
	c, err := theme.ParsePack(pack(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Seeds["accent"] != "#4fa3d9" || c.Name["en"] != "Deep Sea" || c.Tokens["--cd-color-success"] == "" {
		t.Fatalf("parsed: %+v", c)
	}
	c, err = theme.ParsePack(pack(t, map[string]any{"name": "  Plain\x07 ", "format": nil}))
	if err != nil || c.Name["zh"] != "Plain" || c.Name["en"] != "Plain" || c.Format != theme.PackFormat {
		t.Fatalf("string name: %+v %v", c, err)
	}

	bad := map[string]map[string]any{
		"format":      {"format": 3},
		"variant key": {"variants": map[string]any{"dark": map[string]any{"seeds": map[string]string{}}}},
		"variant val": {"variants": map[string]any{"light": map[string]any{"seeds": map[string]string{"text": "x"}}}},
		"base":        {"base": "sepia"},
		"empty name":  {"name": " "},
		"seed key":    {"seeds": map[string]string{"link": "#fff"}},
		"seed value":  {"seeds": map[string]string{"accent": "red"}},
		"token name":  {"tokens": map[string]string{"--cd-radius-md": "#fff"}},
		"token url":   {"tokens": map[string]string{"--cd-color-info": "url(https://x)"}},
		"token break": {"tokens": map[string]string{"--cd-color-info": "#fff; } body {"}},
		"token var":   {"tokens": map[string]string{"--cd-color-info": "var(--cd-color-text)"}},
	}
	for name, over := range bad {
		if _, err := theme.ParsePack(pack(t, over)); !errors.Is(err, theme.ErrInvalid) {
			t.Errorf("%s: want ErrInvalid, got %v", name, err)
		}
	}
	if _, err := theme.ParsePack([]byte("not json")); !errors.Is(err, theme.ErrInvalid) {
		t.Errorf("not json: %v", err)
	}
	big := append([]byte(`{"name":"x","base":"dark","author":"`), make([]byte, theme.MaxPackBytes)...)
	if _, err := theme.ParsePack(big); !errors.Is(err, theme.ErrInvalid) {
		t.Errorf("too large: %v", err)
	}
}

func TestCustomLifecycle(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "theme.json")
	var emitted []theme.State
	var modes []string
	s := theme.New(f, nil, func(st theme.State) { emitted = append(emitted, st) })
	s.SetAppearanceHook(func(m string) { modes = append(modes, m) })

	// 导入 → 存成新主题
	src := filepath.Join(dir, "deep.nomitheme.json")
	_ = os.WriteFile(src, pack(t, nil), 0o644)
	c, err := s.ImportFile(src)
	if err != nil || c.ID == "" {
		t.Fatalf("import: %+v %v", c, err)
	}
	if got := s.ListCustom(); len(got) != 1 || got[0].ID != c.ID {
		t.Fatalf("list: %+v", got)
	}

	// 选中：解析为基底，带上定义，外观跟基底
	st, err := s.Set(theme.CustomPrefix + c.ID)
	if err != nil || st.Resolved != "dark" || st.Custom == nil || st.Custom.ID != c.ID {
		t.Fatalf("set custom: %+v %v", st, err)
	}
	if modes[len(modes)-1] != "dark" {
		t.Fatalf("appearance: %v", modes)
	}
	if _, err := s.Set("custom:nope"); err == nil {
		t.Fatal("unknown custom id should be rejected")
	}

	// 改当前主题：广播新的定义
	n := len(emitted)
	p := theme.Pack{Name: json.RawMessage(`"Light Sea"`), Base: "light", Seeds: map[string]string{"accent": "#4fa3d9"}}
	if _, err := s.SaveCustom(c.ID, p); err != nil {
		t.Fatal(err)
	}
	if len(emitted) != n+1 || emitted[n].Resolved != "light" || emitted[n].Custom.Name["en"] != "Light Sea" {
		t.Fatalf("save active should emit: %+v", emitted[n:])
	}
	if _, err := s.SaveCustom("missing", p); !errors.Is(err, theme.ErrNotFound) {
		t.Fatalf("save missing: %v", err)
	}

	// 重启后还在
	s2 := theme.New(f, nil, nil)
	if st := s2.Get(); st.Pref != theme.CustomPrefix+c.ID || st.Custom == nil {
		t.Fatalf("reload: %+v", st)
	}

	// 导出：不带 id，能再导入
	out := filepath.Join(dir, "out.json")
	if err := s.ExportFile(c.ID, out); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(out)
	if strings.Contains(string(raw), c.ID) {
		t.Fatalf("export leaks id: %s", raw)
	}
	if _, err := theme.ParsePack(raw); err != nil {
		t.Fatalf("export not re-importable: %v", err)
	}
	if name := s.ExportName(c.ID); name != "Light Sea"+theme.PackExt {
		t.Fatalf("export name: %s", name)
	}

	// 删当前主题：退回默认并广播
	if err := s.DeleteCustom(c.ID); err != nil {
		t.Fatal(err)
	}
	if st := s.Get(); st.Pref != theme.DefaultTheme || st.Custom != nil {
		t.Fatalf("after delete: %+v", st)
	}
	if last := emitted[len(emitted)-1]; last.Pref != theme.DefaultTheme {
		t.Fatalf("delete should emit default: %+v", last)
	}
	if _, err := os.Stat(filepath.Join(dir, "themes", c.ID+".json")); !os.IsNotExist(err) {
		t.Fatalf("file not removed: %v", err)
	}
}

// theme.json 指向的自定义主题文件没了：启动时退回默认
func TestMissingCustomFallsBack(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "theme.json")
	_ = os.WriteFile(f, []byte(`{"theme":"custom:gone"}`), 0o600)
	s := theme.New(f, nil, nil)
	if st := s.Get(); st.Pref != theme.DefaultTheme {
		t.Fatalf("got %+v", st)
	}
	raw, _ := os.ReadFile(f)
	if !strings.Contains(string(raw), theme.DefaultTheme) {
		t.Fatalf("not persisted: %s", raw)
	}
}

func pngBytes(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 3))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// 带另一套明暗：跟随系统切换，外观交给系统，系统变了要广播
func TestAdaptiveCustom(t *testing.T) {
	dir := t.TempDir()
	dark := true
	var emitted []theme.State
	var modes []string
	s := theme.New(filepath.Join(dir, "theme.json"), func() bool { return dark }, func(st theme.State) { emitted = append(emitted, st) })
	s.SetAppearanceHook(func(m string) { modes = append(modes, m) })
	c, err := s.SaveCustom("", theme.Pack{
		Name: json.RawMessage(`"Pair"`), Base: "light",
		Seeds:    map[string]string{"accent": "#336699"},
		Variants: map[string]theme.Variant{"dark": {Seeds: map[string]string{"background": "#101418"}}},
	})
	if err != nil || !c.Adaptive() || c.Format != theme.PackFormat {
		t.Fatalf("save: %+v %v", c, err)
	}
	st, _ := s.Set(theme.CustomPrefix + c.ID)
	if st.Resolved != "dark" || modes[len(modes)-1] != "system" {
		t.Fatalf("adaptive dark: %+v %v", st, modes)
	}
	dark = false
	n := len(emitted)
	s.SystemChanged()
	if len(emitted) != n+1 || emitted[n].Resolved != "light" {
		t.Fatalf("system change should emit light: %+v", emitted[n:])
	}
	// 导出 JSON 带 variants，format 2
	out := filepath.Join(dir, "pair.json")
	if err := s.ExportFile(c.ID, out); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(out)
	var p map[string]any
	_ = json.Unmarshal(raw, &p)
	if p["format"] != float64(2) || p["variants"] == nil {
		t.Fatalf("export: %s", raw)
	}
}

func TestBackgroundLifecycle(t *testing.T) {
	dir := t.TempDir()
	s := theme.New(filepath.Join(dir, "theme.json"), nil, nil)
	assets := filepath.Join(dir, "chat", "themes")
	src := filepath.Join(dir, "bg.png")
	_ = os.WriteFile(src, pngBytes(t), 0o644)

	// 选图 → 临时文件
	tmp, err := s.StageBackground(src)
	if err != nil || !strings.HasPrefix(tmp, theme.BackgroundURLPrefix+"tmp-") || !strings.HasSuffix(tmp, ".png") {
		t.Fatalf("stage: %q %v", tmp, err)
	}
	// 不是图片：拒绝
	txt := filepath.Join(dir, "x.png")
	_ = os.WriteFile(txt, []byte("hello"), 0o644)
	if _, err := s.StageBackground(txt); !errors.Is(err, theme.ErrImage) {
		t.Fatalf("non-image: %v", err)
	}

	// 保存：临时图归到主题名下
	p := theme.Pack{Name: json.RawMessage(`"Pic"`), Base: "dark", Background: &theme.Background{Image: tmp, Blur: 99, Opacity: 0.3}}
	c, err := s.SaveCustom("", p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(c.Background.Image, theme.BackgroundURLPrefix+c.ID+"-") || c.Background.Blur != 40 {
		t.Fatalf("saved bg: %+v", c.Background)
	}
	// 别的地址（不是自己的图、不是临时图）拒绝
	bad := p
	bad.Background = &theme.Background{Image: theme.BackgroundURLPrefix + "other-1234.png"}
	if _, err := s.SaveCustom(c.ID, bad); !errors.Is(err, theme.ErrInvalid) {
		t.Fatalf("foreign image: %v", err)
	}
	// 原图不变再存：保留
	same := p
	same.Background = &theme.Background{Image: c.Background.Image, Opacity: 0.6}
	if c2, err := s.SaveCustom(c.ID, same); err != nil || c2.Background.Image != c.Background.Image {
		t.Fatalf("keep image: %+v %v", c2, err)
	}

	// 导出 zip → 再导入
	if name := s.ExportName(c.ID); name != "Pic"+theme.ZipPackExt {
		t.Fatalf("export name: %s", name)
	}
	zipPath := filepath.Join(dir, "pic.nomitheme")
	if err := s.ExportFile(c.ID, zipPath); err != nil {
		t.Fatal(err)
	}
	imp, err := s.ImportFile(zipPath)
	if err != nil || imp.Background == nil || imp.Background.Opacity != 0.6 {
		t.Fatalf("import zip: %+v %v", imp, err)
	}

	// 去掉背景：图删掉
	none := p
	none.Background = nil
	if _, err := s.SaveCustom(c.ID, none); err != nil {
		t.Fatal(err)
	}
	if fileCount(assets) != 1 { // 只剩导入那份
		t.Fatalf("old image not removed: %d files", fileCount(assets))
	}
	// 删主题：图一起删
	_ = s.DeleteCustom(imp.ID)
	if fileCount(assets) != 0 {
		t.Fatalf("image not removed on delete: %d", fileCount(assets))
	}

	// 选了没保存的临时图：重启时清掉
	if _, err := s.StageBackground(src); err != nil {
		t.Fatal(err)
	}
	theme.New(filepath.Join(dir, "theme.json"), nil, nil)
	if fileCount(assets) != 0 {
		t.Fatalf("tmp image not pruned: %d", fileCount(assets))
	}
}

func fileCount(dir string) int {
	ents, _ := os.ReadDir(dir)
	return len(ents)
}

func zipOf(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		w, _ := zw.Create(name)
		_, _ = w.Write(data)
	}
	_ = zw.Close()
	return buf.Bytes()
}

func TestParseZipPack(t *testing.T) {
	meta := []byte(`{"format":2,"name":"Z","base":"light","background":{"image":"background.png","opacity":0.4}}`)
	c, img, err := theme.ParseZipPack(zipOf(t, map[string][]byte{
		"theme.json": meta, "background.png": pngBytes(t), "__MACOSX/._x": {1}, ".DS_Store": {1},
	}))
	if err != nil || img == nil || c.Background == nil || c.Background.Opacity != 0.4 {
		t.Fatalf("zip: %+v %v", c, err)
	}
	for name, files := range map[string]map[string][]byte{
		"extra file":   {"theme.json": meta, "evil.js": []byte("x")},
		"nested":       {"theme.json": meta, "a/background.png": pngBytes(t)},
		"no meta":      {"background.png": pngBytes(t)},
		"traversal":    {"theme.json": meta, "../background.png": pngBytes(t)},
		"bad metadata": {"theme.json": []byte(`{"name":"Z","base":"sepia"}`)},
	} {
		if _, _, err := theme.ParseZipPack(zipOf(t, files)); !errors.Is(err, theme.ErrInvalid) {
			t.Errorf("%s: want ErrInvalid, got %v", name, err)
		}
	}
	// JSON 主题包里的 background 丢掉（图只能从 zip 来）
	if c, err := theme.ParsePack(meta); err != nil || c.Background != nil {
		t.Fatalf("json pack background: %+v %v", c, err)
	}
}
