package onboarding_test

import (
	"encoding/json"
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

func TestMascotForwardsSemanticCommandsOnly(t *testing.T) {
	s := onboarding.New(t.TempDir(), nil, nil, nil)
	type ev struct {
		name string
		data any
	}
	var got []ev
	live := 1
	s.SetMascotPorts(onboarding.MascotPorts{
		Publish:     func(e string, d any) { got = append(got, ev{e, d}) },
		LiveWindows: func() int { return live },
	})
	cases := []struct {
		in   string
		want bool
	}{
		{`{"type":"say","text":"hi","gesture":"wave"}`, true},
		{`{"type":"say","text":"hi","gesture":"rive/clip-7"}`, true}, // 非语义手势丢掉，台词照发
		{`{"type":"say"}`, false},
		{`{"type":"gesture","name":"nod"}`, true},
		{`{"type":"gesture","name":"rive/clip-7"}`, false},
		{`{"type":"reply","phase":"waiting"}`, true},
		{`{"type":"reply","phase":"x"}`, false},
		{`{"type":"eval"}`, false},
		{`null`, false},
	}
	for _, c := range cases {
		if r := s.Mascot(json.RawMessage(c.in)); r != c.want {
			t.Errorf("%s: got %v want %v", c.in, r, c.want)
		}
	}
	if len(got) != 4 || got[0].name != "mascot.command" || got[2].name != "avatar.event" {
		t.Fatalf("events: %+v", got)
	}
	b, _ := json.Marshal(got[1].data)
	if string(b) != `{"type":"say","text":"hi"}` {
		t.Fatalf("non-semantic gesture leaked: %s", b)
	}
	// 没有存活窗口：未送达
	live = 0
	if s.Mascot(json.RawMessage(`{"type":"gesture","name":"nod"}`)) {
		t.Fatal("delivered without live windows")
	}
}
