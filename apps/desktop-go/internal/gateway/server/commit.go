package server

import (
	"errors"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/spec"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	CommitMaxEvents = 8
	CommitMaxMs     = 10_000
)

// PeekResult is PeekResult: Kind "commit" (Res, ContentAt) or "error".
type PeekResult struct {
	Kind           string
	Res            *Resp
	ContentAt      *float64
	Message        string
	Status         int
	UpstreamStatus *int
}

// PeekOptions is PeekOptions (zero MaxEvents/MaxMs = defaults; WaitingMs nil = undefined).
type PeekOptions struct {
	MaxEvents int
	MaxMs     *float64
	WaitingMs *float64
	OnWaiting func()
	Now       func() float64
}

func pick(v any) *u.Obj {
	if o, ok := v.(*u.Obj); ok && o != nil {
		return o
	}
	return u.NewObj()
}

func errorOf(data *u.Obj) (message, kind string) {
	d := pick(data)
	resp := pick(d.Get("response"))
	ev := d.Get("error")
	if ev == nil {
		ev = resp.Get("error")
	}
	e := pick(ev)
	if s, ok := e.Get("message").(string); ok && s != "" {
		message = s
	} else if s, ok := d.Get("message").(string); ok && s != "" {
		message = s
	} else {
		message = "upstream returned an error event"
	}
	var parts []string
	for _, x := range []any{e.Get("type"), e.Get("code"), e.Get("status"), d.Get("code")} {
		if s, ok := x.(string); ok {
			parts = append(parts, s)
		}
	}
	return message, strings.Join(parts, " ") + " " + message
}

var (
	rateKindRe = regexp.MustCompile(`(?i)rate[_ ]?limit|too many requests|quota|429|RESOURCE_EXHAUSTED`)
	overKindRe = regexp.MustCompile(`(?i)overloaded|529|UNAVAILABLE`)
)

func statusOfKind(kind string) (int, *int) {
	k := u.JSIText(kind)
	if rateKindRe.MatchString(k) {
		return 429, u.Ptr(429)
	}
	if overKindRe.MatchString(k) {
		return 529, u.Ptr(529)
	}
	return 502, nil
}

func msTimer(ms float64) *time.Timer {
	if ms < 0 || ms != ms {
		ms = 0
	}
	return time.NewTimer(time.Duration(ms * float64(time.Millisecond)))
}

// PeekCommit is peekCommit.
// A failed upstream read is returned as err (the JS promise rejects).
func PeekCommit(up *Resp, wire string, o PeekOptions) (PeekResult, error) {
	if up.Body == nil {
		return PeekResult{Kind: "commit", Res: up}, nil
	}
	sp := spec.SpecOf(wire)
	maxEvents := o.MaxEvents
	if maxEvents == 0 {
		maxEvents = CommitMaxEvents
	}
	maxMs := float64(CommitMaxMs)
	if o.MaxMs != nil {
		maxMs = *o.MaxMs
	}
	now := o.Now
	if now == nil {
		now = NowMs
	}
	started := now()
	rd := &asyncReader{c: up.Body}
	parser := &sse.Parser{}
	var dec u.TextDecoder
	var head [][]byte
	events := 0
	if o.OnWaiting != nil && o.WaitingMs != nil {
		wt := time.AfterFunc(time.Duration(*o.WaitingMs*float64(time.Millisecond)), o.OnWaiting)
		defer wt.Stop()
	}
	re := func(pending <-chan readResult) *Resp {
		r := *up
		r.Body = &replayChunks{head: head, pending: pending, src: up.Body}
		return &r
	}
	commit := func() PeekResult { return PeekResult{Kind: "commit", Res: re(nil)} }
	deadline := msTimer(maxMs - (now() - started))
	defer deadline.Stop()
	for {
		ch := rd.read()
		var r readResult
		select {
		case <-deadline.C:
			// The read still in flight becomes the first chunk after commit.
			return PeekResult{Kind: "commit", Res: re(ch)}, nil
		case r = <-ch:
			rd.take()
		}
		if r.err != nil {
			if errors.Is(r.err, io.EOF) {
				return commit(), nil
			}
			return PeekResult{}, r.err
		}
		head = append(head, r.b)
		for _, raw := range parser.Push(dec.Decode(r.b)) {
			ev := spec.ToSpecEvent(raw)
			if sp.IsError(ev) {
				msg, kind := errorOf(ev.Data)
				_ = up.Body.Close()
				st, us := statusOfKind(kind)
				return PeekResult{Kind: "error", Message: msg, Status: st, UpstreamStatus: us}, nil
			}
			if sp.IsContent(ev) {
				p := commit()
				t := now()
				p.ContentAt = &t
				return p, nil
			}
			if sp.IsTerminal(ev) {
				return commit(), nil
			}
			if events++; events >= maxEvents {
				return commit(), nil
			}
		}
	}
}
