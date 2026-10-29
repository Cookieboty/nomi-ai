package llm

import (
	"errors"
	"fmt"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// NamedError is an AISDKError (or DOMException / TypeError): Name() is `error.name`.
type NamedError interface {
	error
	Name() string
}

// ErrorString is JS `String(error)` / `error.toString()`: "Name: message".
func ErrorString(err error) string {
	var n NamedError
	if errors.As(err, &n) && n == err {
		if n.Error() == "" {
			return n.Name()
		}
		return n.Name() + ": " + n.Error()
	}
	if n, ok := err.(NamedError); ok {
		return n.Name() + ": " + n.Error()
	}
	return "Error: " + err.Error()
}

// GetErrorMessage is provider-utils getErrorMessage.
func GetErrorMessage(v any) string {
	switch e := v.(type) {
	case nil:
		return "unknown error"
	case string:
		return e
	case error:
		return ErrorString(e)
	}
	return util.Stringify(v)
}

// APICallError is @ai-sdk/provider APICallError.
type APICallError struct {
	Message           string
	URL               string
	RequestBodyValues any
	StatusCode        int // 0 = undefined
	ResponseHeaders   map[string]string
	ResponseBody      *string
	IsRetryable       bool
	Data              any
	Cause             error
}

func (e *APICallError) Error() string { return e.Message }
func (e *APICallError) Name() string  { return "AI_APICallError" }
func (e *APICallError) Unwrap() error { return e.Cause }

// DefaultRetryable is the APICallError constructor default for isRetryable.
func DefaultRetryable(status int) bool {
	return status != 0 && (status == 408 || status == 409 || status == 429 || status >= 500)
}

// NewAPICallError applies the constructor default isRetryable (retryable=nil).
func NewAPICallError(e APICallError, retryable *bool) *APICallError {
	if retryable != nil {
		e.IsRetryable = *retryable
	} else {
		e.IsRetryable = DefaultRetryable(e.StatusCode)
	}
	return &e
}

type InvalidResponseDataError struct {
	Data    any
	Message string
}

func (e *InvalidResponseDataError) Error() string { return e.Message }
func (e *InvalidResponseDataError) Name() string  { return "AI_InvalidResponseDataError" }

func NewInvalidResponseDataError(data any, message string) *InvalidResponseDataError {
	if message == "" {
		message = "Invalid response data: " + util.Stringify(data) + "."
	}
	return &InvalidResponseDataError{Data: data, Message: message}
}

// TypeValidationError: Value is the value that failed the (zod) schema.
// Message detail after "Error message:" is our schema's issue text (D-B5-P-1).
type TypeValidationError struct {
	Value any
	Cause error
	msg   string
}

func (e *TypeValidationError) Error() string { return e.msg }
func (e *TypeValidationError) Name() string  { return "AI_TypeValidationError" }
func (e *TypeValidationError) Unwrap() error { return e.Cause }

func NewTypeValidationError(value any, cause error) *TypeValidationError {
	return &TypeValidationError{Value: value, Cause: cause,
		msg: "Type validation failed: Value: " + util.Stringify(value) + ".\nError message: " + GetErrorMessage(cause)}
}

type JSONParseError struct {
	Text  string
	Cause error
}

func (e *JSONParseError) Error() string {
	return "JSON parsing failed: Text: " + e.Text + ".\nError message: " + GetErrorMessage(e.Cause)
}
func (e *JSONParseError) Name() string  { return "AI_JSONParseError" }
func (e *JSONParseError) Unwrap() error { return e.Cause }

type UnsupportedFunctionalityError struct{ Functionality, Message string }

func (e *UnsupportedFunctionalityError) Error() string { return e.Message }
func (e *UnsupportedFunctionalityError) Name() string  { return "AI_UnsupportedFunctionalityError" }

func NewUnsupported(functionality string) *UnsupportedFunctionalityError {
	return &UnsupportedFunctionalityError{functionality, "'" + functionality + "' functionality not supported."}
}

type InvalidPromptError struct {
	Prompt  any
	Message string
}

func (e *InvalidPromptError) Error() string { return "Invalid prompt: " + e.Message }
func (e *InvalidPromptError) Name() string  { return "AI_InvalidPromptError" }

type InvalidArgumentError struct{ Argument, Message string }

func (e *InvalidArgumentError) Error() string { return e.Message }
func (e *InvalidArgumentError) Name() string  { return "AI_InvalidArgumentError" }

type EmptyResponseBodyError struct{}

func (e *EmptyResponseBodyError) Error() string { return "Empty response body" }
func (e *EmptyResponseBodyError) Name() string  { return "AI_EmptyResponseBodyError" }

// SyntaxError is a JS SyntaxError (JSON.parse / secure-json-parse).
type SyntaxError struct{ Message string }

func (e *SyntaxError) Error() string { return e.Message }
func (e *SyntaxError) Name() string  { return "SyntaxError" }

// AbortError is the DOMException fetch / delay reject with on abort.
type AbortError struct{ Message string }

func (e *AbortError) Error() string { return e.Message }
func (e *AbortError) Name() string  { return "AbortError" }

// ErrAborted is undici's abort reason ("This operation was aborted").
func ErrAborted() *AbortError { return &AbortError{"This operation was aborted"} }

// IsAbortError is provider-utils isAbortError.
func IsAbortError(err error) bool {
	if n, ok := err.(NamedError); ok {
		switch n.Name() {
		case "AbortError", "ResponseAborted", "TimeoutError":
			return true
		}
	}
	return false
}

// RetryError is ai's RetryError.
type RetryError struct {
	Message string
	Reason  string // maxRetriesExceeded | errorNotRetryable | abort
	Errors  []error
}

func (e *RetryError) Error() string { return e.Message }
func (e *RetryError) Name() string  { return "AI_RetryError" }
func (e *RetryError) LastError() error {
	if len(e.Errors) == 0 {
		return nil
	}
	return e.Errors[len(e.Errors)-1]
}

// NetError is a network failure (undici "fetch failed" TypeError with a cause
// carrying a code such as ECONNREFUSED).
type NetError struct {
	Code    string
	Message string
}

func (e *NetError) Error() string { return e.Message }
func (e *NetError) Name() string  { return "Error" }

// ErrorJSON describes an error for goldens: { name, message, ...fields }.
func ErrorJSON(err error) *util.Obj {
	if err == nil {
		return nil
	}
	o := util.NewObj()
	switch e := err.(type) {
	case *APICallError:
		o.Set("name", e.Name()).Set("message", e.Message).Set("url", e.URL)
		if e.StatusCode != 0 {
			o.Set("statusCode", float64(e.StatusCode))
		}
		if e.ResponseBody != nil {
			o.Set("responseBody", *e.ResponseBody)
		}
		o.Set("isRetryable", e.IsRetryable)
		if e.Data != nil {
			o.Set("data", e.Data)
		}
		if e.ResponseHeaders != nil {
			h := util.NewObj()
			for _, k := range sortedKeys(e.ResponseHeaders) {
				h.Set(k, e.ResponseHeaders[k])
			}
			o.Set("responseHeaders", h)
		}
		if e.Cause != nil {
			o.Set("cause", ErrorJSON(e.Cause))
		}
	case *TypeValidationError:
		o.Set("name", e.Name()).Set("value", e.Value)
	case *JSONParseError:
		o.Set("name", e.Name()).Set("text", e.Text)
	case *InvalidResponseDataError:
		o.Set("name", e.Name()).Set("message", e.Message)
		if e.Data != nil {
			o.Set("data", e.Data)
		}
	case *RetryError:
		o.Set("name", e.Name()).Set("message", e.Message).Set("reason", e.Reason)
		errs := []any{}
		for _, x := range e.Errors {
			errs = append(errs, ErrorJSON(x))
		}
		o.Set("errors", errs)
	case NamedError:
		o.Set("name", e.Name()).Set("message", e.Error())
	default:
		o.Set("name", "Error").Set("message", err.Error())
	}
	return o
}

func sortedKeys(m map[string]string) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	for i := 1; i < len(ks); i++ {
		for j := i; j > 0 && ks[j] < ks[j-1]; j-- {
			ks[j], ks[j-1] = ks[j-1], ks[j]
		}
	}
	return ks
}

var _ = fmt.Sprintf
var _ = strings.TrimSpace
