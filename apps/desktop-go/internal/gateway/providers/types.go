// Package providers mirrors packages/gateway/src/providers/*.
package providers

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// KeepAlive is one response.keepAlive rule.
type KeepAlive struct {
	Field  string
	Equals any
}

// EventRule is 'drop' (Drop) or { rename }.
type EventRule struct {
	Drop   bool
	Rename string
}

// Response is ProviderSpec.response.
type Response struct {
	KeepAlive []KeepAlive
	Events    map[string]EventRule
}

// ModelOverride is one ProviderSpec.models row.
type ModelOverride struct {
	Match []string
	Spec  *u.Obj // ModelSpecData
}

// Spec is ProviderSpec.
type Spec struct {
	ID      string
	Presets []string
	Hosts   []string
	Native  string // "" | anthropic | openai
	Request *config.ProviderQuirks
	Resp    *Response
	Hooks   *Hooks
	Models  []ModelOverride
}

// Context is ProviderContext.
type Context struct {
	Candidate *cand.Candidate
	Spec      *Spec
	Native    string
	Quirks    *config.ProviderQuirks
	Notes     *[]string
}

// PreResult is the result of a preEvent hook: Alive, Drop, or Event.
type PreResult struct {
	Alive bool
	Drop  bool
	Event *sse.Event
}

// Hooks is ProviderAdapterHooks.
type Hooks struct {
	Request  func(wire string, body *u.Obj, ctx *Context)
	PreEvent func(wire string, ev *sse.Event, spec *Spec) PreResult
}
