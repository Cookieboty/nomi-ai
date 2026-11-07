package agents

import "testing"

func TestLevelFromAvailable(t *testing.T) {
	for avail, want := range map[float64]string{-1: PressureUnknown, 3: PressureCritical, 10: PressureWarn, 50: PressureNormal} {
		if got := levelFromAvailable(avail); got != want {
			t.Errorf("levelFromAvailable(%v) = %s, want %s", avail, got, want)
		}
	}
}
