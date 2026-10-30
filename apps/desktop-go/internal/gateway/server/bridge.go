package server

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/canonical"
	resp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// BridgeMode is 'passthrough' | 'convert'.
type BridgeMode = string

// BridgePlan is BridgePlan (bridge.ts).
type BridgePlan struct {
	From, To    string
	Mode        BridgeMode
	Model       string
	CustomTools map[string]bool
	Fixes       *resp.FixOptions
	Heartbeat   string // "" = wire default
}

// TruncatedMessage is TRUNCATED_MESSAGE.
const TruncatedMessage = "Nomi 网关：上游没有发结束标记就断开了"

// BridgeModeOf is bridgeMode(from, to, needsConversion).
func BridgeModeOf(from, to string, needsConversion bool) BridgeMode {
	if from == to && !needsConversion {
		return "passthrough"
	}
	return "convert"
}

// Bridge is the object createBridge returns.
type Bridge struct {
	plan   BridgePlan
	pass   stream.Passthrough
	watch  *stream.TerminalWatch
	conv   *stream.StreamConverter
	canon  *canonical.ResponsesCanonicalizer
	framer sse.Splitter
	wrote  bool
}

// CreateBridge is createBridge(plan).
func CreateBridge(plan BridgePlan) *Bridge {
	b := &Bridge{plan: plan}
	if plan.Mode == "passthrough" {
		b.pass = stream.CreatePassthrough(plan.From, plan.Fixes)
		b.watch = stream.NewTerminalWatch(plan.From)
	} else {
		b.conv = stream.CreateStreamConverter(plan.From, plan.To,
			stream.WithFixes(stream.ConvertOptions{Model: plan.Model, CustomTools: plan.CustomTools}, plan.Fixes))
	}
	if plan.To == "responses" {
		b.canon = canonical.NewResponsesCanonicalizer(plan.Model)
	}
	return b
}

// Mode is bridge.mode.
func (b *Bridge) Mode() BridgeMode { return b.plan.Mode }

func (b *Bridge) write(chunk string) string {
	if b.canon != nil {
		return b.canon.Push(chunk)
	}
	return chunk
}

// Stopped is bridge.stopped.
func (b *Bridge) Stopped() bool {
	return (b.conv != nil && b.conv.Stopped()) || (b.pass != nil && b.pass.Stopped())
}

func (b *Bridge) forward(events string) string {
	if b.pass != nil {
		return b.write(b.pass.Push(events))
	}
	return b.write(events)
}

func (b *Bridge) sent(s string) string {
	if s != "" {
		b.wrote = true
	}
	return s
}

// Push is push(text).
func (b *Bridge) Push(text string) string {
	if b.conv != nil {
		return b.sent(b.write(b.conv.Push(text)))
	}
	events := b.framer.PushRaw(text)
	if events == "" {
		return ""
	}
	b.watch.Push(events)
	return b.sent(b.forward(events))
}

// Alive is alive().
func (b *Bridge) Alive() string {
	if b.wrote {
		return stream.Heartbeat(b.plan.To, b.plan.Heartbeat)
	}
	return stream.HeartbeatComment
}

// End is end(rest).
func (b *Bridge) End(rest string) string {
	out := ""
	halted := b.Stopped()
	if !halted {
		if b.conv != nil {
			out += b.write(b.conv.Push(rest) + b.conv.End())
		} else {
			out += b.forward(b.framer.PushRaw(rest))
			last := b.framer.Take()
			b.watch.Push(last)
			if u.JSTrim(last) != "" && b.watch.Terminated() {
				out += b.forward(last)
			}
			if b.pass != nil {
				out += b.write(b.pass.End())
			}
		}
	}
	if b.canon != nil {
		out += b.canon.End()
	}
	if b.watch != nil && !halted && !b.watch.Terminated() {
		out += b.write(stream.PassthroughFail(b.plan.From, TruncatedMessage))
	}
	return out
}

// Fail is fail(message).
func (b *Bridge) Fail(message string) string {
	b.framer.Take()
	tail := ""
	if b.canon != nil {
		tail = b.canon.End()
	}
	if b.conv != nil {
		return tail + b.conv.Fail(message)
	}
	return tail + b.write(stream.PassthroughFail(b.plan.From, message))
}

// UpstreamJSON is bridgeJson's `up`. ContentType nil = null.
type UpstreamJSON struct {
	Status      int
	ContentType *string
	Text        string
	Parsed      any
}

// JSONBridgeOutput is JsonBridgeOutput: Kind "sse" | "raw" | "json".
type JSONBridgeOutput struct {
	Kind        string
	Status      int
	ContentType string
	Body        string // sse / raw
	JSON        any    // json
}

func isJSObject(v any) bool {
	switch x := v.(type) {
	case *u.Obj:
		return x != nil
	case []any:
		return true
	}
	return false
}

// BridgeJSON is bridgeJson(plan, up, wantsStream).
func BridgeJSON(plan BridgePlan, up UpstreamJSON, wantsStream bool) JSONBridgeOutput {
	parsed := up.Parsed
	isObject := isJSObject(parsed)
	opts := stream.WithFixes(stream.ConvertOptions{Model: plan.Model, CustomTools: plan.CustomTools}, plan.Fixes)
	if wantsStream && isObject {
		s := stream.JsonToSse(plan.From, plan.To, parsed, opts)
		if plan.To != "responses" {
			return JSONBridgeOutput{Kind: "sse", Body: s}
		}
		c := canonical.NewResponsesCanonicalizer(plan.Model)
		return JSONBridgeOutput{Kind: "sse", Body: c.Push(s) + c.End()}
	}
	passthrough := plan.Mode == "passthrough"
	if passthrough || !isObject {
		ct := "application/json"
		if up.ContentType != nil {
			ct = *up.ContentType
		}
		var body string
		switch {
		case plan.To == "responses" && isObject:
			body = u.Stringify(canonical.CompleteResponsesBody(parsed, plan.Model))
		case passthrough && plan.From == "chat" && isObject:
			if p := stream.PatchChatJson(parsed, plan.Fixes); !sameRef(p, parsed) {
				body = u.Stringify(p)
			} else {
				body = up.Text
			}
		default:
			body = up.Text
		}
		return JSONBridgeOutput{Kind: "raw", Status: up.Status, ContentType: ct, Body: body}
	}
	r := stream.JsonToJson(plan.From, plan.To, parsed, opts)
	body := r.Body
	if plan.To == "responses" {
		body = canonical.CompleteResponsesBody(r.Body, plan.Model)
	}
	return JSONBridgeOutput{Kind: "json", Status: int(r.Status), JSON: body}
}

// sameRef is JS `a === b` for parsed JSON containers.
func sameRef(a, b any) bool {
	switch x := a.(type) {
	case *u.Obj:
		y, ok := b.(*u.Obj)
		return ok && x == y
	case []any:
		y, ok := b.([]any)
		return ok && len(x) == len(y) && (len(x) == 0 || &x[0] == &y[0])
	}
	return a == b
}
