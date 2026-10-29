package onboarding_test

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/onboarding"
)

func TestOnboardingFlow(t *testing.T) {
	dir := t.TempDir()
	s := onboarding.New(dir, nil, nil, nil)
	if s.Get().Done {
		t.Fatal("fresh should not be done")
	}
	role := "dev"
	p := s.SetProfile(&role, []string{"code"})
	if p.Role != "dev" || len(p.Interests) != 1 {
		t.Fatalf("%+v", p)
	}
	st := s.Complete(false)
	if !st.Done || st.Skipped == nil || *st.Skipped {
		t.Fatalf("%+v", st)
	}
	s2 := onboarding.New(dir, nil, nil, nil)
	if !s2.Get().Done {
		t.Fatal("persist")
	}
}
