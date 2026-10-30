package chatbg

import (
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSanitizeParity(t *testing.T) {
	b, err := os.ReadFile("testdata/sanitize.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Input, Out string }
	_ = json.Unmarshal(b, &cases)
	if len(cases) < 1000 {
		t.Fatal(len(cases))
	}
	for _, c := range cases {
		var raw any
		_ = json.Unmarshal([]byte(c.Input), &raw)
		got, _ := json.Marshal(Sanitize(raw))
		if string(got) != c.Out {
			t.Fatalf("%s:\n got  %s\n want %s", c.Input, got, c.Out)
		}
	}
}

func TestServiceFlow(t *testing.T) {
	ud := t.TempDir()
	preset := filepath.Join(ud, "assets", "backgrounds", "nomi-preset.jpg")
	_ = os.MkdirAll(filepath.Dir(preset), 0o755)
	_ = os.WriteFile(preset, []byte("x"), 0o644)
	var events int
	pick := ""
	s := New(filepath.Join(ud, File), filepath.Join(ud, "chat", "images"), preset,
		Ports{PickFiles: func(string, []Filter) ([]string, error) {
			if pick == "" {
				return nil, nil
			}
			return []string{pick}, nil
		}}, func(k string) string { return k }, func(State) { events++ })
	if g := s.Get(); g.ImageURL == nil || *g.ImageURL != PresetURL || g.Blur != 8 {
		t.Fatalf("%+v", g)
	}
	st, err := s.Set(json.RawMessage(`{"blur":100,"opacity":0,"imageUrl":"chat-asset://images/panel-bg.missing.png"}`))
	if err != nil || st.Blur != 40 || st.Opacity != 0.05 || *st.ImageURL != PresetURL {
		t.Fatalf("%+v %v", st, err)
	}
	// 大图缩到 2560 最长边
	big := filepath.Join(ud, "big.png")
	f, _ := os.Create(big)
	_ = png.Encode(f, image.NewRGBA(image.Rect(0, 0, 3000, 100)))
	f.Close()
	pick = big
	st, err = s.PickImage()
	if err != nil || st.ImageURL == nil || !strings.HasPrefix(*st.ImageURL, ImageURLPrefix+"panel-bg.") {
		t.Fatalf("%+v %v", st, err)
	}
	name := strings.TrimPrefix(*st.ImageURL, ImageURLPrefix)
	rf, _ := os.Open(filepath.Join(ud, "chat", "images", name))
	cfg, _, err := image.DecodeConfig(rf)
	rf.Close()
	if err != nil || cfg.Width != 2560 || cfg.Height != 85 {
		t.Fatalf("%+v %v", cfg, err)
	}
	// 重新启动：持久化的用户图片仍有效
	s2 := New(filepath.Join(ud, File), filepath.Join(ud, "chat", "images"), preset, Ports{}, nil, nil)
	if *s2.Get().ImageURL != *st.ImageURL {
		t.Fatal(s2.Get())
	}
	bad := filepath.Join(ud, "a.bmp")
	_ = os.WriteFile(bad, []byte("x"), 0o644)
	if _, err := s.ImportImage(bad); ErrorCode(err) != ErrUnsupported {
		t.Fatal(err)
	}
	if _, err := s.Reset(); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(filepath.Join(ud, "chat", "images")); len(ents) != 0 || *s.Get().ImageURL != PresetURL {
		t.Fatal(ents)
	}
	if events != 3 || ErrorCode(errors.New("x")) != "" {
		t.Fatal(events)
	}
}
