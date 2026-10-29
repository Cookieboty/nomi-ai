package mediahandlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// D-B9-3：config.json voiceSettings 读（默认深合并）→ saveMascotVoiceSettings → 落盘，未知键 / 键序同 Node
func TestParityB9MascotVoiceSettings(t *testing.T) {
	var g struct {
		Mascot []struct {
			File      json.RawMessage
			Patch     json.RawMessage
			Got       string
			Published string
			Saved     string
		}
	}
	raw, err := os.ReadFile(filepath.Join("..", "voice", "testdata", "parity-b9.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Mascot) == 0 {
		t.Fatal("golden has no mascot cases")
	}
	for i, c := range g.Mascot {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "config.json"), c.File, 0o600); err != nil {
			t.Fatal(err)
		}
		a := ConfigAdapter{C: services.NewConfig(dir)}
		if got := util.Stringify(voice.GetMascotVoiceSettings(a)); got != c.Got {
			t.Errorf("#%d get\n go=%s\nnode=%s", i, got, c.Got)
		}
		pv, _ := util.Parse(c.Patch)
		var published any
		voice.SaveMascotVoiceSettings(a, pv.(*util.Obj), nil, func(_ string, p any) { published = p })
		if got := util.Stringify(published); got != c.Published {
			t.Errorf("#%d published\n go=%s\nnode=%s", i, got, c.Published)
		}
		b, _ := os.ReadFile(filepath.Join(dir, "config.json"))
		var m map[string]json.RawMessage
		_ = json.Unmarshal(b, &m)
		sv, _ := util.Parse(m["voiceSettings"])
		if got := util.Stringify(sv); got != c.Saved {
			t.Errorf("#%d saved\n go=%s\nnode=%s", i, got, c.Saved)
		}
		// 重新加载后仍保留
		if got := util.Stringify(voice.GetMascotVoiceSettings(ConfigAdapter{C: services.NewConfig(dir)})); got != c.Saved {
			t.Errorf("#%d reload\n go=%s\nnode=%s", i, got, c.Saved)
		}
	}
}
