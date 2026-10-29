package aisdk

import (
	"context"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// retryWithExponentialBackoffRespectingRetryHeaders (ai) over retryWithExponentialBackoffInternal
// (provider-utils): maxRetries 2, initial delay 2000 ms, factor 2.

// AbortError mirrors the DOMException thrown when the abort signal fires.
type AbortError struct{}

func (AbortError) Error() string  { return "This operation was aborted" }
func (AbortError) JSName() string { return "AbortError" }

func isAbortError(ctx context.Context, err error) bool {
	var a AbortError
	return errors.As(err, &a) || errors.Is(err, context.Canceled) || ctx.Err() != nil
}

// sleepFn is swappable in tests only to observe delays; production waits for real.
var sleepFn = func(ctx context.Context, ms float64) error {
	if ms <= 0 {
		select {
		case <-ctx.Done():
			return AbortError{}
		default:
			return nil
		}
	}
	t := time.NewTimer(time.Duration(ms * float64(time.Millisecond)))
	defer t.Stop()
	select {
	case <-ctx.Done():
		return AbortError{}
	case <-t.C:
		return nil
	}
}

func withRetry[T any](ctx context.Context, maxRetries int, f func() (T, error)) (T, error) {
	var errs []error
	delay := 2000.0
	for {
		v, err := f()
		if err == nil {
			return v, nil
		}
		var zero T
		if isAbortError(ctx, err) {
			return zero, AbortError{}
		}
		if maxRetries == 0 {
			return zero, err
		}
		msg := GetErrorMessage(err)
		errs = append(errs, err)
		n := len(errs)
		if n > maxRetries {
			return zero, &RetryError{Message: "Failed after " + strconv.Itoa(n) + " attempts. Last error: " + msg,
				Reason: "maxRetriesExceeded", Errors: errs, LastError: err}
		}
		var api *APICallError
		if errors.As(err, &api) && api.IsRetryable {
			if e := sleepFn(ctx, retryDelayMs(api, delay)); e != nil {
				return zero, e
			}
			delay *= 2
			continue
		}
		if n == 1 {
			return zero, err
		}
		return zero, &RetryError{Message: "Failed after " + strconv.Itoa(n) + " attempts with non-retryable error: '" + msg + "'",
			Reason: "errorNotRetryable", Errors: errs, LastError: err}
	}
}

func retryDelayMs(e *APICallError, backoff float64) float64 {
	h := e.ResponseHeaders
	if h == nil {
		return backoff
	}
	ms := math.NaN()
	set := false
	if v := h["retry-after-ms"]; v != "" {
		if f := jsParseFloat(v); !math.IsNaN(f) {
			ms, set = f, true
		}
	}
	if v := h["retry-after"]; v != "" && !set {
		if f := jsParseFloat(v); !math.IsNaN(f) {
			ms = f * 1000
		} else if t, err := http.ParseTime(v); err == nil {
			ms = float64(time.Until(t).Milliseconds())
		}
	}
	if !math.IsNaN(ms) && 0 <= ms && (ms < 60000 || ms < backoff) {
		return ms
	}
	return backoff
}

var floatPrefix = regexp.MustCompile(`^[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)`)

// jsParseFloat: global parseFloat (leading numeric prefix, else NaN).
func jsParseFloat(s string) float64 {
	m := floatPrefix.FindString(trimLeftJS(s))
	if m == "" {
		return math.NaN()
	}
	switch m {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	f, err := strconv.ParseFloat(m, 64)
	if err != nil {
		// prefix like "1e" is cut by the regexp; overflow → ±Inf like JS
		return f
	}
	return f
}

func trimLeftJS(s string) string {
	t := jsTrim(s + "x")
	return t[:len(t)-1]
}
