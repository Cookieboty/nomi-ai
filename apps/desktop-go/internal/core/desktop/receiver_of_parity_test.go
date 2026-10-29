package desktop

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

func TestReceiverOfGolden(t *testing.T) {
	p, _ := paritytest.Golden(t, "b7s2-receiver.json", "testdata/b7s2-receiver.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Registry map[string]struct {
			Name    string `json:"name"`
			BaseURL string `json:"baseURL"`
		} `json:"registry"`
		Cases []struct {
			WithRuntime bool `json:"withRuntime"`
			Provider    struct {
				ID      string `json:"id"`
				BaseURL string `json:"baseURL"`
			} `json:"provider"`
			Out Provider `json:"out"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	for i, c := range g.Cases {
		s.runtime = nil
		if c.WithRuntime {
			s.runtime = &RuntimeHooks{LookupProvider: func(id string) *RuntimeProvider {
				r, ok := g.Registry[id]
				if !ok {
					return nil
				}
				return &RuntimeProvider{ID: id, Name: r.Name, BaseURL: r.BaseURL}
			}}
		}
		if got := s.ReceiverOf(c.Provider.ID, c.Provider.BaseURL); *got != c.Out {
			t.Errorf("#%d %+v: got %+v want %+v", i, c.Provider, *got, c.Out)
		}
	}
}
