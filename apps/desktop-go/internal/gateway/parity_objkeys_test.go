package gateway_test

import (
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// D20 removed: *Obj orders keys like JS (array-index keys ascending first).
func TestParityObjKeys(t *testing.T) {
	var fx struct {
		Cases []struct{ Input, Parsed, Mutated string }
	}
	loadFixture(t, "objkeys", &fx)
	tl := tally{}
	for _, c := range fx.Cases {
		v, err := u.ParseString(c.Input)
		if err != nil {
			t.Fatal(err)
		}
		o := v.(*u.Obj)
		ok := u.Stringify(o) == c.Parsed
		if !ok {
			t.Errorf("parse %s: %s want %s", c.Input, u.Stringify(o), c.Parsed)
		}
		tl.add("parsed", ok)
		o.Set("7", "n")
		o.Set("z", "m")
		o.Delete("b")
		m := o.Clone()
		m.Set("3", "q")
		ok = u.Stringify(m) == c.Mutated
		if !ok {
			t.Errorf("mutate %s: %s want %s", c.Input, u.Stringify(m), c.Mutated)
		}
		tl.add("mutated", ok)
	}
	tl.report(t, "objkeys")
}
