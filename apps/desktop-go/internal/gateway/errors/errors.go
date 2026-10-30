// Package errors mirrors apps/desktop-electron/internal/gateway/src/errors.ts: errors encoded per
// ingress wire so each CLI's own retry logic recognises them.
package errors

import (
	"regexp"
	"strconv"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ErrorKind values.
const (
	RateLimit       = "rate_limit"
	Overloaded      = "overloaded"
	Auth            = "auth"
	Invalid         = "invalid"
	NotFound        = "not_found"
	Context         = "context"
	PayloadTooLarge = "payload_too_large"
	Upstream        = "upstream"
	Timeout         = "timeout"
)

// ClientStatusOf is clientStatusOf.
func ClientStatusOf(status int) int {
	switch {
	case status == 401 || status == 403:
		return 502
	case status >= 300 && status < 400:
		return 502
	case status < 500:
		return status
	case status == 503 || status == 504 || status == 529:
		return status
	}
	return 502
}

// UpstreamAuthMessage is upstreamAuthMessage.
func UpstreamAuthMessage(status int, message string) string {
	return "上游拒绝了这个供应商的 Key（" + strconv.Itoa(status) + "），请在「模型」页检查 Key：" + message
}

var contextRe = regexp.MustCompile(`(?i)context|too long|maximum context|token limit`)
var promptTooLongRe = regexp.MustCompile(`(?i)prompt is too long`)

// KindOfStatus is kindOfStatus.
func KindOfStatus(status int, message string) string {
	switch {
	case status == 504:
		return Timeout
	case status == 429:
		return RateLimit
	case status == 503 || status == 529:
		return Overloaded
	case status == 401 || status == 403:
		return Auth
	case status == 404:
		return NotFound
	case status == 413:
		return PayloadTooLarge
	case status == 400 && contextRe.MatchString(message):
		return Context
	case status >= 400 && status < 500:
		return Invalid
	}
	return Upstream
}

var statusOf = map[string]int{RateLimit: 429, Overloaded: 503, Auth: 401, Invalid: 400, NotFound: 404, Context: 400, PayloadTooLarge: 413, Upstream: 502, Timeout: 504}

var messagesType = map[string]string{RateLimit: "rate_limit_error", Overloaded: "overloaded_error", Auth: "authentication_error", Invalid: "invalid_request_error", NotFound: "not_found_error", Context: "invalid_request_error", PayloadTooLarge: "invalid_request_error", Upstream: "api_error", Timeout: "api_error"}

var geminiStatus = map[string]string{RateLimit: "RESOURCE_EXHAUSTED", Overloaded: "UNAVAILABLE", Auth: "UNAUTHENTICATED", Invalid: "INVALID_ARGUMENT", NotFound: "NOT_FOUND", Context: "INVALID_ARGUMENT", PayloadTooLarge: "INVALID_ARGUMENT", Upstream: "INTERNAL", Timeout: "DEADLINE_EXCEEDED"}

var openaiCode = map[string]string{RateLimit: "rate_limit_exceeded", Overloaded: "server_error", Auth: "invalid_api_key", Invalid: "invalid_request_error", NotFound: "model_not_found", Context: "context_length_exceeded", PayloadTooLarge: "invalid_request_error", Upstream: "server_error", Timeout: "timeout"}

func obj(kv ...any) *u.Obj {
	o := u.NewObj()
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// ErrorResponse is errorResponse.
func ErrorResponse(ingress, kind, message string) (int, *u.Obj) {
	status := statusOf[kind]
	if ingress == "messages" && kind == Overloaded {
		status = 529
	}
	switch ingress {
	case "messages":
		msg := message
		if kind == Context && !promptTooLongRe.MatchString(message) {
			msg = "prompt is too long: " + message
		}
		return status, obj("type", "error", "error", obj("type", messagesType[kind], "message", msg))
	case "gemini":
		return status, obj("error", obj("code", float64(status), "message", message, "status", geminiStatus[kind]))
	}
	code := openaiCode[kind]
	typ := code
	if kind == Invalid || kind == Context || kind == NotFound || kind == PayloadTooLarge {
		typ = "invalid_request_error"
	}
	return status, obj("error", obj("message", message, "type", typ, "code", code))
}

// UpstreamMessage is upstreamMessage.
func UpstreamMessage(text string) string {
	if v, err := u.ParseString(text); err == nil {
		if j, ok := v.(*u.Obj); ok {
			switch e := j.Get("error").(type) {
			case string:
				return e
			case *u.Obj:
				if m, ok := e.Get("message").(string); ok {
					return m
				}
			}
			if m, ok := j.Get("message").(string); ok {
				return m
			}
		}
	}
	if text == "" {
		return "upstream error"
	}
	return u.UTF16Slice0(text, 500)
}
