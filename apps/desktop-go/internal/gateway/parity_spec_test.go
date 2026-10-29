package gateway_test

import (
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/spec"
)

func b2s(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func TestParitySpec(t *testing.T) {
	var fx struct {
		Cases []struct {
			Name, Wire, Input, Flags string
			Violations               []spec.Violation
		}
	}
	loadFixture(t, "spec", &fx)
	tl := tally{}
	for _, c := range fx.Cases {
		s := spec.SpecOf(c.Wire)
		evs := spec.ParseSpecEvents(c.Input)
		got := s.Validate(evs)
		var flags []string
		for _, e := range evs {
			flags = append(flags, b2s(s.IsTerminal(e))+b2s(s.IsContent(e))+b2s(s.IsError(e)))
		}
		ok := true
		if len(got) != 0 || len(c.Violations) != 0 {
			ok = reflect.DeepEqual(got, c.Violations)
		}
		if !ok {
			t.Errorf("%s: violations node=%v go=%v", c.Name, c.Violations, got)
		}
		if f := strings.Join(flags, ","); f != c.Flags {
			t.Errorf("%s: flags node=%s go=%s (%s events)", c.Name, c.Flags, f, strconv.Itoa(len(evs)))
			ok = false
		}
		tl.add("spec "+c.Wire, ok)
	}
	tl.report(t, "spec")
}
