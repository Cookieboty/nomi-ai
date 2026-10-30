package i18n_test

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

func TestLocaleResolve(t *testing.T) {
	f := filepath.Join(t.TempDir(), "locale.json")
	s := i18n.New(f, []string{"en-US"}, nil)
	if s.Get().Locale != "en" {
		t.Fatalf("%+v", s.Get())
	}
	st, err := s.Set("zh-CN")
	if err != nil || st.Locale != "zh-CN" {
		t.Fatalf("%+v %v", st, err)
	}
}
