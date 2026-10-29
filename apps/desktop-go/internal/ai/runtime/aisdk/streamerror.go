package aisdk

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// streamError.ts: describeStreamError — one short readable line for a stream error (#78).

const maxErrLen = 500

// errView exposes an error value as the JS object describeStreamError inspects.
func errView(e any) (*u.Obj, bool) {
	switch x := e.(type) {
	case *u.Obj:
		return x, true
	case *ValueError:
		return errView(x.Value)
	case *APICallError:
		o := u.NewObj("message", x.Message)
		if x.StatusCode != 0 {
			o.Set("statusCode", float64(x.StatusCode))
		}
		o.Set("data", x.Data)
		return o, true
	case *StreamProviderError:
		o := u.NewObj("message", x.Message)
		if x.StatusCode != 0 {
			o.Set("statusCode", float64(x.StatusCode))
		}
		o.Set("data", x.Data)
		return o, true
	case *RetryError:
		o := u.NewObj("message", x.Message)
		if x.LastError != nil {
			o.Set("lastError", x.LastError)
		}
		return o, true
	case error:
		o := u.NewObj("message", x.Error())
		if c := errors.Unwrap(x); c != nil {
			o.Set("cause", c)
		}
		return o, true
	}
	return nil, false
}

func jsTrim(s string) string { return u.JSTrim(s) }

func strField(v any) (string, bool) {
	switch x := v.(type) {
	case string:
		if t := jsTrim(x); t != "" {
			return t, true
		}
	case float64:
		return u.FormatNumber(x), true
	}
	return "", false
}

type codeMsg struct {
	code, message       string
	hasCode, hasMessage bool
}

func upstreamError(value any) *codeMsg {
	v, ok := value.(*u.Obj)
	if !ok {
		return nil
	}
	var err any
	switch v.Get("type") {
	case "response.failed", "response.incomplete":
		resp, ok := v.Get("response").(*u.Obj)
		if !ok {
			resp = u.NewObj()
		}
		err = resp.Get("error")
		if _, isO := err.(*u.Obj); !isO {
			if d, ok := resp.Get("incomplete_details").(*u.Obj); ok {
				err = u.NewObj("code", d.Get("reason"), "message", d.Get("reason"))
			}
		}
	case "error":
		if e, ok := v.Get("error").(*u.Obj); ok {
			err = e
		} else {
			err = v
		}
	default:
		if e, ok := v.Get("error").(*u.Obj); ok {
			err = e
		}
	}
	eo, ok := err.(*u.Obj)
	if !ok {
		return nil
	}
	r := &codeMsg{}
	if c, ok := strField(eo.Get("code")); ok {
		r.code, r.hasCode = c, true
	} else if c, ok := strField(eo.Get("type")); ok {
		r.code, r.hasCode = c, true
	}
	if _, isStr := eo.Get("message").(string); isStr {
		r.message, r.hasMessage = strField(eo.Get("message"))
	}
	if !r.hasCode && !r.hasMessage {
		return nil
	}
	return r
}

// utf16Len / utf16Slice: JS string length / slice semantics.
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func clip(s string) string {
	one := jsTrim(s)
	units := utf16.Encode([]rune(one))
	if len(units) > maxErrLen {
		return string(utf16.Decode(units[:maxErrLen])) + "…"
	}
	return one
}

func httpStatus(e any) (int, bool) {
	o, ok := errView(e)
	if !ok {
		return 0, false
	}
	for _, k := range []string{"statusCode", "status", "status_code"} {
		switch v := o.Get(k).(type) {
		case float64:
			if !math.IsInf(v, 0) && !math.IsNaN(v) {
				return int(v), true
			}
		case string:
			if threeDigits.MatchString(v) {
				n, _ := strconv.Atoi(v)
				return n, true
			}
		}
	}
	if o.Has("cause") && o.Get("cause") != nil && o.Get("cause") != e {
		return httpStatus(o.Get("cause"))
	}
	if o.Has("lastError") && o.Get("lastError") != nil && o.Get("lastError") != e {
		return httpStatus(o.Get("lastError"))
	}
	return 0, false
}

var httpPrefix = regexp.MustCompile(`(?i)^HTTP\s+\d{3}`)

// DescribeStreamError: streamError.ts describeStreamError.
func DescribeStreamError(e any) string {
	status, hasStatus := httpStatus(e)
	body, hasBody := "", false
	if o, ok := errView(e); ok {
		if fv := upstreamErrorIf(o, "value"); fv != nil {
			body, hasBody = format(fv), true
		} else if fd := upstreamErrorIf(o, "data"); fd != nil {
			body, hasBody = format(fd), true
		} else if le := o.Get("lastError"); o.Has("lastError") && le != nil && le != e {
			inner := DescribeStreamError(le)
			if strings.HasPrefix(inner, "[") || httpPrefix.MatchString(inner) {
				return inner
			}
		}
	}
	if !hasBody || body == "" {
		if err, ok := e.(error); ok {
			if ve, ok := err.(*ValueError); ok {
				body = clip(jsString(ve.Value))
			} else {
				body = clip(err.Error())
			}
		} else {
			body = clip(jsString(e))
		}
	}
	if hasStatus {
		s := strconv.Itoa(status)
		if !regexp.MustCompile(`\b` + s + `\b`).MatchString(body) {
			return clip("HTTP " + s + ": " + body)
		}
	}
	return body
}

func upstreamErrorIf(o *u.Obj, k string) *codeMsg {
	if !o.Has(k) {
		return nil
	}
	return upstreamError(o.Get(k))
}

func format(c *codeMsg) string {
	if !c.hasCode {
		return clip(c.message)
	}
	m := ""
	if c.hasMessage && c.message != c.code {
		m = c.message
	}
	return clip(jsTrim("[" + c.code + "] " + m))
}
