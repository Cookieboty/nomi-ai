package screen

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type warnRec struct{ ms []string }

func (w *warnRec) Warn(m string, _ any) { w.ms = append(w.ms, m) }

type gold struct {
	Cases []struct {
		Locale   string            `json:"locale"`
		Provider *desktop.Provider `json:"provider"`
		Answer   *string           `json:"answer"`
		Calls    json.RawMessage   `json:"calls"`
		Out      string            `json:"out"`
	} `json:"cases"`
	Unavailable contract.ErrorPayload `json:"unavailable"`
	Purge       []struct {
		Kind     string   `json:"kind"`
		Exists   bool     `json:"exists"`
		Warns    []string `json:"warns"`
		Siblings []string `json:"siblings"`
	} `json:"purge"`
}

func call(t *testing.T, r *contract.Router) contract.ServerFrame {
	ch := make(chan contract.ServerFrame, 1)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	b, _ := json.Marshal(contract.ClientFrame{T: "req", ID: "1", Kind: "call", Name: "screen.checkSend", Input: json.RawMessage("{}")})
	s.Handle(b)
	return <-ch
}

func jsonEq(t *testing.T, a, b any) bool {
	x, _ := json.Marshal(a)
	var av, bv any
	json.Unmarshal(x, &av)
	y, _ := json.Marshal(b)
	json.Unmarshal(y, &bv)
	return fmt.Sprint(av) == fmt.Sprint(bv)
}

func TestScreenGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s2-screen.json", "testdata/b7s2-screen.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g gold
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	defer i18n.SetLocale(nil)
	for i, c := range g.Cases {
		loc := c.Locale
		i18n.SetLocale(func() string { return loc })
		var calls []any
		svc := New(Deps{
			Root:   filepath.Join(t.TempDir(), "gone"),
			Logger: &warnRec{},
			ProviderFor: func(role desktop.Role) *desktop.Provider {
				calls = append(calls, []any{"providerFor", role})
				return c.Provider
			},
			CheckSend: func(pr *desktop.Provider, sig context.Context, what string) string {
				var sg any
				if sig != nil {
					sg = "signal"
				}
				calls = append(calls, []any{"checkSend", pr, sg, what})
				if c.Answer == nil {
					return ""
				}
				return *c.Answer
			},
		})
		<-svc.LegacyPurged
		r := contract.NewRouter()
		Register(r, func() *Service { return svc })
		f := call(t, r)
		var want any
		json.Unmarshal(c.Calls, &want)
		if f.T != "res" || f.Output != c.Out || !jsonEq(t, calls, want) {
			t.Errorf("case %d: %+v calls %v want %s / %v", i, f, calls, c.Out, want)
		}
	}
	r := contract.NewRouter()
	Register(r, func() *Service { return nil })
	if f := call(t, r); f.T != "err" || *f.Error != g.Unavailable {
		t.Errorf("unavailable: %+v", f)
	}
	for _, pc := range g.Purge {
		tmp := t.TempDir()
		root := filepath.Join(tmp, "screen-memory")
		switch pc.Kind {
		case "tree":
			os.MkdirAll(filepath.Join(root, "thumbs", "a"), 0o755)
			os.WriteFile(filepath.Join(root, "thumbs", "a", "x.png"), []byte("x"), 0o644)
			os.WriteFile(filepath.Join(root, "index.json"), []byte("{}"), 0o644)
		case "file":
			os.WriteFile(root, []byte("f"), 0o644)
		}
		w := &warnRec{}
		<-New(Deps{Root: root, Logger: w}).LegacyPurged
		_, err := os.Stat(root)
		ents, _ := os.ReadDir(tmp)
		if (err == nil) != pc.Exists || len(w.ms) != len(pc.Warns) || len(ents) != len(pc.Siblings) {
			t.Errorf("purge %s: exists=%v warns=%v sib=%d", pc.Kind, err == nil, w.ms, len(ents))
		}
	}
}
