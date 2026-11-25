package delegate

import (
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestDeriveEffectiveRoutingAndLocalAvailableForAntigravity(t *testing.T) {
	_, presets, _ := DeriveEffectiveRoutingWithEnv(util.NewObj(), RoutingEnv{
		Installed: []string{"antigravity"},
		HasLocal:  func(c string) bool { return c == "antigravity" },
		OfficialModels: func(c, src string) []string {
			if c == "antigravity" && src == "local" {
				return []string{"auto", "gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-3.8-flash"}
			}
			return nil
		},
	})

	high := FindPreset(presets, "high")
	if high == nil || util.Str(high.Get("cli")) != "antigravity" || util.Str(high.Get("source")) != "local" {
		t.Fatalf("unexpected antigravity high preset: %s", util.Stringify(high))
	}
	if util.Str(high.Get("model")) == "" {
		t.Fatalf("expected non-empty model picked for antigravity high preset, got %s", util.Stringify(high))
	}

	balanced := FindPreset(presets, "balanced")
	if balanced == nil || util.Str(balanced.Get("cli")) != "antigravity" || util.Str(balanced.Get("source")) != "local" {
		t.Fatalf("unexpected antigravity balanced preset: %s", util.Stringify(balanced))
	}

	dir := t.TempDir()
	sc := util.NewObj(
		"installed", []any{"antigravity"},
		"granted", []any{dir},
		"recent", []any{dir},
	)
	log := &envLog{}
	svc := New(Deps{
		Root:          t.TempDir(),
		Harness:       &fakeHarness{sc: sc, base: dir, log: log, cancelCh: make(chan struct{}, 2)},
		Desktop:       &fakeDesktop{sc: sc, base: dir, log: log},
		Events:        fakeEvents{log},
		Edits:         NewEditLog(),
		Tasks:         newFakeTasks(),
		RetryBackoff:  func(int) time.Duration { return 0 },
		HasLocalLogin: func(k string) bool { return k == "antigravity" },
	})
	st := svc.Settings()
	localAvail := util.AsObj(st.Get("localAvailable"))
	if localAvail == nil || localAvail.Get("antigravity") != true {
		t.Fatalf("Settings().localAvailable.antigravity = %v, want true", util.Stringify(localAvail))
	}
}
