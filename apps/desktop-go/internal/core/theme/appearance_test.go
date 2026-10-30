package theme

import "testing"

func TestAppearanceFor(t *testing.T) {
	for pref, want := range map[string]string{"system": "system", "graphite": "dark", "ink": "dark", "cream": "light", "image": "dark"} {
		if got := AppearanceFor(pref); got != want {
			t.Errorf("%s: got %s want %s", pref, got, want)
		}
	}
}

func TestAppearanceHookFollowsSet(t *testing.T) {
	s := New(t.TempDir()+"/theme.json", nil, nil)
	var got []string
	s.SetAppearanceHook(func(m string) { got = append(got, m) })
	if _, err := s.Set("graphite"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Set("system"); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[1] != "dark" || got[2] != "system" {
		t.Fatalf("got %v", got)
	}
}
