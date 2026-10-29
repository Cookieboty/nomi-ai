package upstream

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	resp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/toolnames"
)

func notFalse(b *bool) bool { return b == nil || *b }

// ResponseFixOptions is responseFixOptions.
func ResponseFixOptions(ingress string, c *cand.Candidate, body any, notes *[]string) *resp.FixOptions {
	q := providers.QuirksOf(c.Provider, c.Wire)
	var sw struct{ chatStream, toolNames, textToolCalls, repetition *bool }
	if q != nil && q.Fixes != nil {
		sw.chatStream, sw.toolNames, sw.textToolCalls, sw.repetition = q.Fixes.ChatStream, q.Fixes.ToolNames, q.Fixes.TextToolCalls, q.Fixes.Repetition
	}
	fromChat := c.Wire == "chat"
	var names []string
	if fromChat {
		names = toolnames.IngressToolNames(ingress, body)
	}
	cs := notFalse(sw.chatStream)
	o := &resp.FixOptions{ChatStream: &cs, Repetition: notFalse(sw.repetition), Notes: notes}
	if fromChat && notFalse(sw.toolNames) {
		o.ToolNames = toolnames.ChatToolNameReverse(names)
	}
	if fromChat && notFalse(sw.textToolCalls) && len(names) > 0 {
		o.TextTools = map[string]bool{}
		for _, n := range names {
			o.TextTools[n] = true
		}
	}
	seed := resp.CallIDSeed(body)
	o.CallIds = resp.NewCallIds(&seed)
	return o
}
