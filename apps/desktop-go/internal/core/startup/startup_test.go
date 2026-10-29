package startup_test

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/startup"
)

func TestDefaultsAndSet(t *testing.T) {
	f := filepath.Join(t.TempDir(), "startup.json")
	s := startup.New(f, nil)
	st := s.Get()
	if st.DefaultView != "mascot" || !st.ShowMascot || st.CloseMain != "hide" {
		t.Fatalf("%+v", st)
	}
	st, err := s.Set(map[string]any{"defaultView": "main", "showMascot": false})
	if err != nil {
		t.Fatal(err)
	}
	if st.DefaultView != "main" || st.ShowMascot {
		t.Fatalf("%+v", st)
	}
	s2 := startup.New(f, nil)
	if s2.Get() != st {
		t.Fatalf("reload %+v vs %+v", s2.Get(), st)
	}
}
