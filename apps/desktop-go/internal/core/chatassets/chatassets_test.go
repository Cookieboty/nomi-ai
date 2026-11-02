package chatassets

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func setup(t *testing.T) (*Library, func(string, int64), *[]string, *[]string, *int, string) {
	root := t.TempDir()
	images := filepath.Join(root, "images")
	_ = os.MkdirAll(images, 0o700)
	put := func(name string, ms int64) {
		p := filepath.Join(images, name)
		_ = os.WriteFile(p, []byte("x"), 0o600)
		tm := time.UnixMilli(ms)
		_ = os.Chtimes(p, tm, tm)
	}
	trashed, revealed, changed := &[]string{}, &[]string{}, new(int)
	l := New(Deps{ChatRoot: root,
		TrashItem:        func(p string) error { *trashed = append(*trashed, filepath.Base(p)); return os.Remove(p) },
		ShowItemInFolder: func(p string) { *revealed = append(*revealed, filepath.Base(p)) },
		OnChanged:        func() { *changed++ }})
	return l, put, trashed, revealed, changed, images
}

func TestSourceOf(t *testing.T) {
	cases := map[string]string{"nomi-abc-123.png": "nomi", "gen-abc-123.png": "nomi", "grok-5f0e.jpg": "grok",
		"codex-1.webp": "codex", "chat-bg.1234.png": "", "panel-bg.jpg": "", "nomi-x.txt": "", "evil-x.png": ""}
	for f, want := range cases {
		if got := SourceOf(f); got != want {
			t.Fatalf("%s → %q want %q", f, got, want)
		}
	}
}

func TestListRecordRemoveReveal(t *testing.T) {
	l, put, trashed, revealed, changed, images := setup(t)
	put("grok-a.png", 1_700_000_000_000)
	put("nomi-b.png", 1_700_000_100_000)
	put("panel-bg.jpg", 1_700_000_200_000)
	l.Record("nomi-b.png", Meta{Model: "amux/gpt-image-2", Prompt: "a red fox", ConversationID: "c1"})
	if *changed != 1 {
		t.Fatal(*changed)
	}
	items := l.List()
	if len(items) != 2 || items[0].File != "nomi-b.png" || items[0].Source != "nomi" || items[1].Source != "grok" {
		t.Fatalf("%+v", items)
	}
	if items[0].Model != "amux/gpt-image-2" || items[0].Prompt != "a red fox" || items[0].URL != "chat-asset://images/nomi-b.png" || items[0].Bytes != 1 {
		t.Fatalf("%+v", items[0])
	}
	if !l.Reveal("grok-a.png") || l.Reveal("panel-bg.jpg") || l.Reveal("nomi-missing.png") || !slices.Equal(*revealed, []string{"grok-a.png"}) {
		t.Fatal("reveal")
	}
	got := l.Remove([]string{"nomi-b.png", "panel-bg.jpg", "../x.png", "nomi-gone.png"})
	if !slices.Equal(got, []string{"nomi-b.png"}) || !slices.Equal(*trashed, []string{"nomi-b.png"}) {
		t.Fatalf("%v %v", got, *trashed)
	}
	if _, err := os.Stat(filepath.Join(images, "panel-bg.jpg")); err != nil {
		t.Fatal("背景图不应被删")
	}
	put("nomi-b.png", 1)
	for _, it := range l.List() {
		if it.File == "nomi-b.png" && it.Model != "" {
			t.Fatal("删除后说明应清掉")
		}
	}
}

func TestListNoDir(t *testing.T) {
	if got := New(Deps{ChatRoot: filepath.Join(t.TempDir(), "none")}).List(); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestRegenerateAndSaveAs(t *testing.T) {
	root := t.TempDir()
	images := filepath.Join(root, "images")
	_ = os.MkdirAll(images, 0o700)
	_ = os.WriteFile(filepath.Join(images, "nomi-a.png"), []byte("x"), 0o600)
	_ = os.WriteFile(filepath.Join(images, "grok-g.png"), []byte("x"), 0o600)
	var reqs []GenerateReq
	dest := filepath.Join(root, "out.png")
	pick := dest
	l := New(Deps{ChatRoot: root, SaveFile: func(string) string { return pick }})
	l.SetGenerate(func(r GenerateReq) (string, error) {
		reqs = append(reqs, r)
		_ = os.WriteFile(filepath.Join(images, "nomi-new.png"), []byte("y"), 0o600)
		return "nomi-new.png", nil
	})
	l.Record("nomi-a.png", Meta{Model: "amux/gpt-image-2", Prompt: "a fox", Aspect: "3:2", References: []string{"grok-g.png"}})
	it, err := l.Regenerate("nomi-a.png")
	if err != nil || it.File != "nomi-new.png" {
		t.Fatal(it, err)
	}
	if r := reqs[0]; r.Prompt != "a fox" || r.Aspect != "3:2" || r.ModelRef != "amux/gpt-image-2" || strings.Join(r.References, ",") != "grok-g.png" {
		t.Fatalf("%+v", r)
	}
	if _, err := l.Regenerate("grok-g.png"); err == nil {
		t.Fatal("没有提示词不能重新生成")
	}
	if ok, err := l.SaveAs("nomi-a.png"); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if b, _ := os.ReadFile(dest); string(b) != "x" {
		t.Fatal("saveAs")
	}
	pick = ""
	if ok, _ := l.SaveAs("nomi-a.png"); ok {
		t.Fatal("取消")
	}
	if ok, _ := l.SaveAs("panel-bg.jpg"); ok {
		t.Fatal("非素材库文件")
	}
}

// 长提示词原样保存，重新生成发的是全文（#225）
func TestRegenerateKeepsFullPrompt(t *testing.T) {
	root := t.TempDir()
	images := filepath.Join(root, "images")
	_ = os.MkdirAll(images, 0o700)
	_ = os.WriteFile(filepath.Join(images, "nomi-a.png"), []byte("x"), 0o600)
	var last GenerateReq
	l := New(Deps{ChatRoot: root})
	l.SetGenerate(func(r GenerateReq) (string, error) {
		last = r
		_ = os.WriteFile(filepath.Join(images, "nomi-new.png"), []byte("y"), 0o600)
		return "nomi-new.png", nil
	})
	for _, p := range []string{
		strings.Repeat("p", 2000),
		strings.Repeat("p", 2000) + "KEEP",
		strings.Repeat("p", 3996) + "KEEP",
		strings.Repeat("狐", 1998) + "😀😀",
	} {
		l.Record("nomi-a.png", Meta{Model: "amux/gpt-image-2", Prompt: p})
		if _, err := l.Regenerate("nomi-a.png"); err != nil || last.Prompt != p {
			t.Fatalf("len=%d: got len %d, err %v", len(p), len(last.Prompt), err)
		}
	}
}
