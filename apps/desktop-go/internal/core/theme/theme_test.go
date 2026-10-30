package theme_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/theme"
)

func TestDefaultsAndPersist(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "theme.json")
	s := theme.New(f, func() bool { return true }, nil)
	st := s.Get()
	if st.Pref != theme.DefaultTheme || st.Resolved != theme.DefaultTheme {
		t.Fatalf("default: %+v", st)
	}
	st, err := s.Set("system")
	if err != nil {
		t.Fatal(err)
	}
	if st.Resolved != "graphite" {
		t.Fatalf("system+dark → graphite, got %s", st.Resolved)
	}
	raw, _ := os.ReadFile(f)
	var j map[string]string
	_ = json.Unmarshal(raw, &j)
	if j["theme"] != "system" {
		t.Fatalf("persist: %s", raw)
	}
	s2 := theme.New(f, func() bool { return false }, nil)
	if s2.Get().Resolved != "cream" {
		t.Fatalf("reload system+light: %+v", s2.Get())
	}
}

func TestLegacyPaper(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "theme.json")
	_ = os.WriteFile(f, []byte(`{"theme":"paper"}`), 0o600)
	s := theme.New(f, nil, nil)
	if s.Get().Pref != "cream" {
		t.Fatalf("paper→cream: %+v", s.Get())
	}
}
