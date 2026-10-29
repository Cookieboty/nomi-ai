package request

import u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// ModelRequest is modelRequest (o is the caller's shallow copy, rewritten in place).
func ModelRequest(wire string, o, m *u.Obj, notes *[]string) (*ParamChanges, error) {
	ch, err := NormalizeParams(wire, o, m, notes)
	if err != nil {
		return nil, err
	}
	if userSet(m, "reasoning") && at(m, "reasoning", "control") == "none" {
		DropReasoning(o, wire, notes)
	}
	if wire == "messages" {
		FitThinkingBudget(o, notes)
	}
	if at(m, "input", "images") == false {
		StripImages(o, wire, notes)
	}
	CleanSchemas(wire, o, m, notes)
	return ch, nil
}
