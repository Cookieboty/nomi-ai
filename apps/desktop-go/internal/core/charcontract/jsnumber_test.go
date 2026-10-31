package charcontract

import "testing"

// = (n).toString() in V8：小于 1e-6、不小于 1e21 用指数形式
func TestJSNumberMatchesV8(t *testing.T) {
	for in, want := range map[float64]string{
		1e-6: "0.000001", 1e-7: "1e-7", 1.5e-7: "1.5e-7", -2e-7: "-2e-7",
		0.5: "0.5", 123: "123", 1e20: "100000000000000000000", 1e21: "1e+21", 1.5e21: "1.5e+21",
	} {
		if got := JSNumber(in); got != want {
			t.Errorf("JSNumber(%v) = %q, want %q", in, got, want)
		}
	}
}
