package chatassets

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestClassifyByKeywords(t *testing.T) {
	for prompt, want := range map[string]string{
		"一只在窗台晒太阳的小橘猫":                       "animal",
		"a portrait of a girl by the window": "people",
		"女孩在海边的漫画":                           "people", // 人物比画风具体
		"日落时的雪山和湖":                           "landscape",
		"扁平风格的产品海报":                          "illustration", // 「海报」不算海
		"":                                   "other",
		"一个咖啡杯":                              "other",
		// 英文按整词：delicate 里的 cat、woman 里的 man 不算
		"a woman with delicate lines on the beach": "people",
		"two cats playing":                         "animal",
		"a delicate watercolor":                    "illustration",
	} {
		if got := ClassifyByKeywords(prompt); got != want {
			t.Errorf("ClassifyByKeywords(%q) = %q, want %q", prompt, got, want)
		}
	}
	if ParseCategory("Category: landscape.") != "landscape" || ParseCategory("动物") != "animal" || ParseCategory("不知道") != "" {
		t.Fatal("ParseCategory")
	}
}

func writePNG(t *testing.T, path string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.White)
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

// 生成后先按关键词分、辅助模型再分；用户改过的不被覆盖；列出时带真实尺寸、标签清理
func TestCategoryTagsAndSize(t *testing.T) {
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "images"), 0o700)
	writePNG(t, filepath.Join(root, "images", "nomi-1.png"), 30, 20)
	classified := make(chan struct{}, 1)
	l := New(Deps{ChatRoot: root, Classify: func(string) (string, error) { return "illustration", nil },
		OnChanged: func() {
			select {
			case classified <- struct{}{}:
			default:
			}
		}})
	l.Record("nomi-1.png", Meta{Prompt: "一只猫"})
	it := l.List()[0]
	if it.Width != 30 || it.Height != 20 {
		t.Fatalf("size %+v", it)
	}
	// 后台辅助模型分完：illustration（ai）
	deadline := time.Now().Add(2 * time.Second)
	for l.List()[0].CategoryBy != "ai" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := l.List()[0]; got.Category != "illustration" || got.CategoryBy != "ai" {
		t.Fatalf("ai category %+v", got)
	}
	cat := "animal"
	got, err := l.Update("nomi-1.png", Patch{Category: &cat, Tags: []string{" 猫咪 ", "猫咪", "", "可爱"}, SetTags: true})
	if err != nil || got.Category != "animal" || got.CategoryBy != "user" || len(got.Tags) != 2 {
		t.Fatalf("update %+v %v", got, err)
	}
	l.classifyAsync("nomi-1.png", "x") // 用户改过：不覆盖
	if l.List()[0].Category != "animal" {
		t.Fatal("user choice kept")
	}
	bad := "food"
	if _, err := l.Update("nomi-1.png", Patch{Category: &bad}); err != ErrBadCategory {
		t.Fatalf("bad category: %v", err)
	}
	if _, err := l.Update("nomi-2.png", Patch{}); err != ErrUnknownAsset {
		t.Fatalf("unknown: %v", err)
	}
}

func TestWebpSize(t *testing.T) {
	// VP8X：宽高各 3 字节，存的是减 1 的值
	b := make([]byte, 30)
	copy(b, "RIFF")
	copy(b[8:], "WEBPVP8X")
	b[24], b[25] = 0xff, 0x03 // 1023 → 1024
	b[27], b[28] = 0xff, 0x01 // 511 → 512
	if w, h, ok := webpSize(b); !ok || w != 1024 || h != 512 {
		t.Fatalf("vp8x %d %d %v", w, h, ok)
	}
}
