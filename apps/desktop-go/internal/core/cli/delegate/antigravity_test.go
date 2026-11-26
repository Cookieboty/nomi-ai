package delegate

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestAntigravityExcludedFromDelegationAndRouting(t *testing.T) {
	if slices.Contains(DelegateClis, "antigravity") {
		t.Fatalf("DelegateClis must exclude interactive-only antigravity: %v", DelegateClis)
	}

	_, presets, _ := DeriveEffectiveRoutingWithEnv(util.NewObj(), RoutingEnv{
		Installed: []string{"antigravity"},
		HasLocal:  func(c string) bool { return c == "antigravity" },
		OfficialModels: func(c, src string) []string {
			if c == "antigravity" && src == "local" {
				return []string{"auto", "gemini-4-neon", "gemini-4-carbon"}
			}
			return nil
		},
	})

	for _, id := range []string{"high", "balanced", "low"} {
		if p := FindPreset(presets, id); p != nil && util.Str(p.Get("cli")) == "antigravity" {
			t.Fatalf("preset %q must not resolve to interactive-only antigravity: %s", id, util.Stringify(p))
		}
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
	if localAvail != nil && localAvail.Get("antigravity") != nil {
		t.Fatalf("Settings().localAvailable must omit antigravity, got %s", util.Stringify(localAvail))
	}
	if _, err := svc.Pin("antigravity", "turn-1"); err == nil {
		t.Fatal("Pin(\"antigravity\") must return error")
	}
	if _, err := svc.Dispatch(context.Background(), DispatchInput{Cli: "antigravity", Goal: "fix tests"}); err == nil {
		t.Fatal("Dispatch(Cli: \"antigravity\") must return error")
	}
}
