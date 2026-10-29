package aisdk

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Error shapes of @ai-sdk/provider + ai (dist/index.js). Each error carries the JS `name` so
// getErrorMessage (error.toString()) prints "AI_X: message" exactly like Node.

// Named is implemented by every error that has a JS name other than "Error".
type Named interface{ JSName() string }

func jsName(err error) string {
	var n Named
	if errors.As(err, &n) {
		return n.JSName()
	}
	return "Error"
}

// ErrorToString is Error.prototype.toString: "name: message" (name alone when message is empty).
func ErrorToString(err error) string {
	name, msg := jsName(err), err.Error()
	if msg == "" {
		return name
	}
	return name + ": " + msg
}

// GetErrorMessage mirrors @ai-sdk/provider getErrorMessage.
func GetErrorMessage(v any) string {
	switch x := v.(type) {
	case nil:
		return "unknown error"
	case string:
		return x
	case error:
		return ErrorToString(x)
	}
	return u.Stringify(v)
}

// APICallError: @ai-sdk/provider APICallError (fields used by the runtime).
type APICallError struct {
	Message         string
	URL             string
	StatusCode      int // 0 = undefined
	ResponseHeaders map[string]string
	ResponseBody    string
	Data            any
	IsRetryable     bool
}

func (e *APICallError) Error() string  { return e.Message }
func (e *APICallError) JSName() string { return "AI_APICallError" }

// NewAPICallError applies the default isRetryable (408/409/429/≥500).
func NewAPICallError(msg string, status int, headers map[string]string, data any) *APICallError {
	return &APICallError{Message: msg, StatusCode: status, ResponseHeaders: headers, Data: data,
		IsRetryable: status != 0 && (status == 408 || status == 409 || status == 429 || status >= 500)}
}

// RetryError: ai RetryError.
type RetryError struct {
	Message   string
	Reason    string // maxRetriesExceeded | errorNotRetryable | abort
	Errors    []error
	LastError error
}

func (e *RetryError) Error() string  { return e.Message }
func (e *RetryError) JSName() string { return "AI_RetryError" }
func (e *RetryError) Unwrap() error  { return e.LastError }

// StreamProviderError: ai normalizeStreamProviderError result.
type StreamProviderError struct {
	Message     string
	Type        any
	Code        any
	StatusCode  int
	IsRetryable bool
	Data        any
}

func (e *StreamProviderError) Error() string  { return e.Message }
func (e *StreamProviderError) JSName() string { return "AI_StreamProviderError" }

// NoSuchToolError / InvalidToolInputError / JSONParseError / NoOutputGeneratedError.
type NoSuchToolError struct{ Message, ToolName string }

func (e *NoSuchToolError) Error() string  { return e.Message }
func (e *NoSuchToolError) JSName() string { return "AI_NoSuchToolError" }

type InvalidToolInputError struct {
	Message, ToolName, ToolInput string
	Cause                        error
}

func (e *InvalidToolInputError) Error() string  { return e.Message }
func (e *InvalidToolInputError) JSName() string { return "AI_InvalidToolInputError" }

type JSONParseError struct {
	Message, Text string
	Cause         error
}

func (e *JSONParseError) Error() string  { return e.Message }
func (e *JSONParseError) JSName() string { return "AI_JSONParseError" }

// SyntaxError: JS SyntaxError (secure-json-parse / JSON.parse).
type SyntaxError struct{ Message string }

func (e *SyntaxError) Error() string  { return e.Message }
func (e *SyntaxError) JSName() string { return "SyntaxError" }

type NoOutputGeneratedError struct{ Message string }

func (e *NoOutputGeneratedError) Error() string  { return e.Message }
func (e *NoOutputGeneratedError) JSName() string { return "AI_NoOutputGeneratedError" }

// ValueError wraps a non-Error thrown/streamed value (JS `throw {…}` / error part with a plain object).
type ValueError struct{ Value any }

func (e *ValueError) Error() string { return jsString(e.Value) }

// jsString is String(v) for the JSON value space.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case u.JSUndefined:
		return "undefined"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return u.FormatNumber(x)
	case int:
		return strconv.Itoa(x)
	case *u.Obj:
		return "[object Object]"
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case error:
		return ErrorToString(x)
	}
	return fmt.Sprint(v)
}

/* ---------------- normalizeStreamProviderError (ai dist) ---------------- */

var threeDigits = regexp.MustCompile(`^\d{3}$`)

func statusOf(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		if x == math.Trunc(x) && x >= 400 && x <= 599 {
			return int(x), true
		}
	case string:
		if threeDigits.MatchString(x) {
			n, _ := strconv.Atoi(x)
			if n >= 400 && n <= 599 {
				return n, true
			}
		}
	}
	return 0, false
}

func strOrNum(v any) any {
	switch v.(type) {
	case string, float64:
		return v
	}
	return nil
}

// NormalizeStreamProviderError turns an error stream part's raw value into the error streamText emits.
func NormalizeStreamProviderError(raw any) any {
	if _, ok := raw.(error); ok {
		return raw
	}
	outer, ok := raw.(*u.Obj)
	if !ok {
		return raw
	}
	details := outer
	if r, ok := outer.Get("response").(*u.Obj); ok {
		if d, ok := r.Get("error").(*u.Obj); ok {
			details = d
		} else if d, ok := outer.Get("error").(*u.Obj); ok {
			details = d
		}
	} else if d, ok := outer.Get("error").(*u.Obj); ok {
		details = d
	}
	msg, ok := details.Get("message").(string)
	if !ok {
		return raw
	}
	var typ any
	if s, ok := details.Get("type").(string); ok {
		typ = s
	} else if s, ok := outer.Get("type").(string); ok {
		typ = s
	}
	code := strOrNum(details.Get("code"))
	if code == nil {
		code = strOrNum(outer.Get("code"))
	}
	status := 0
	for _, k := range []string{"statusCode", "status_code", "status", "code"} {
		if n, ok := statusOf(details.Get(k)); ok {
			status = n
			break
		}
		if n, ok := statusOf(outer.Get(k)); ok {
			status = n
			break
		}
	}
	metaStatus, metaRetry := 0, false
	switch strings.ToLower(strings.TrimSpace(msg)) {
	case "overloaded", "overloaded error", "model overloaded", "service unavailable":
		metaStatus, metaRetry = 503, true
	case "internal server error":
		metaStatus, metaRetry = 500, true
	}
	if status == 0 {
		status = metaStatus
	}
	var retry bool
	explicit := false
	for _, kv := range [][2]any{{details, "isRetryable"}, {outer, "isRetryable"}, {details, "is_retryable"}, {outer, "is_retryable"}} {
		if b, ok := kv[0].(*u.Obj).Get(kv[1].(string)).(bool); ok {
			retry, explicit = b, true
			break
		}
	}
	if !explicit {
		if metaStatus != 0 {
			retry = metaRetry
		} else {
			retry = status != 0 && (status == 408 || status == 409 || status == 429 || status >= 500)
		}
	}
	return &StreamProviderError{Message: msg, Type: typ, Code: code, StatusCode: status, IsRetryable: retry, Data: raw}
}
