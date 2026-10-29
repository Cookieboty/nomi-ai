package llm

import (
	"context"
	"math"
	"strconv"
	"strings"
	"time"
)

// RetryOptions is ai's retryWithExponentialBackoffRespectingRetryHeaders
// (prepareRetries: maxRetries default 2, initialDelay 2000ms, factor 2).
type RetryOptions struct {
	MaxRetries     *int
	InitialDelayMs float64 // 0 = 2000
	BackoffFactor  float64 // 0 = 2
	// Additional is additionalRetryableError.
	Additional func(error) bool
	Now        func() time.Time
	// Sleep replaces the abortable delay (tests record requested delays).
	Sleep func(ctx context.Context, ms float64) error
}

// Retry runs f with ai's retry policy. Abort = ctx.
func Retry[T any](ctx context.Context, o RetryOptions, f func() (T, error)) (T, error) {
	maxRetries := 2
	if o.MaxRetries != nil {
		if *o.MaxRetries < 0 {
			var zero T
			return zero, &InvalidArgumentError{Argument: "maxRetries", Message: "maxRetries must be >= 0"}
		}
		maxRetries = *o.MaxRetries
	}
	delay := o.InitialDelayMs
	if delay == 0 {
		delay = 2000
	}
	factor := o.BackoffFactor
	if factor == 0 {
		factor = 2
	}
	var errs []error
	for {
		v, err := f()
		if err == nil {
			return v, nil
		}
		if IsAbortError(err) || maxRetries == 0 {
			return v, err
		}
		msg := GetErrorMessage(err)
		errs = append(errs, err)
		try := len(errs)
		if try > maxRetries {
			return v, &RetryError{Message: "Failed after " + strconv.Itoa(try) + " attempts. Last error: " + msg,
				Reason: "maxRetriesExceeded", Errors: errs}
		}
		ae, isAPI := err.(*APICallError)
		should := (isAPI && ae.IsRetryable) || (o.Additional != nil && o.Additional(err))
		if should {
			ms := delay
			if isAPI {
				ms = retryDelayMs(ae, delay, o.Now)
			}
			sl := sleep
			if o.Sleep != nil {
				sl = o.Sleep
			}
			if derr := sl(ctx, ms); derr != nil {
				return v, derr
			}
			delay *= factor
			continue
		}
		if try == 1 {
			return v, err
		}
		return v, &RetryError{Message: "Failed after " + strconv.Itoa(try) + " attempts with non-retryable error: '" + msg + "'",
			Reason: "errorNotRetryable", Errors: errs}
	}
}

func sleep(ctx context.Context, ms float64) error {
	if ctx.Err() != nil {
		return &AbortError{"Delay was aborted"}
	}
	if ms <= 0 || math.IsNaN(ms) {
		ms = 0
	}
	t := time.NewTimer(time.Duration(ms * float64(time.Millisecond)))
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return &AbortError{"Delay was aborted"}
	}
}

// retryDelayMs is getRetryDelayInMs (retry-after-ms, then retry-after).
func retryDelayMs(e *APICallError, backoff float64, now func() time.Time) float64 {
	h := e.ResponseHeaders
	if h == nil {
		return backoff
	}
	var ms *float64
	if v := h["retry-after-ms"]; v != "" {
		if f, ok := parseFloatJS(v); ok {
			ms = &f
		}
	}
	if v := h["retry-after"]; v != "" && ms == nil {
		if f, ok := parseFloatJS(v); ok {
			x := f * 1000
			ms = &x
		} else if t, err := time.Parse(time.RFC1123, v); err == nil {
			n := time.Now
			if now != nil {
				n = now
			}
			x := float64(t.Sub(n()).Milliseconds())
			ms = &x
		}
	}
	if ms != nil && !math.IsNaN(*ms) && *ms >= 0 && (*ms < 60000 || *ms < backoff) {
		return *ms
	}
	return backoff
}

// parseFloatJS is parseFloat: longest numeric prefix after leading whitespace.
func parseFloatJS(s string) (float64, bool) {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	end := 0
	seenDigit, seenDot, seenExp := false, false, false
	for end < len(s) {
		c := s[end]
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
		case (c == '+' || c == '-') && (end == 0 || s[end-1] == 'e' || s[end-1] == 'E'):
		case c == '.' && !seenDot && !seenExp:
			seenDot = true
		case (c == 'e' || c == 'E') && seenDigit && !seenExp:
			seenExp = true
		default:
			goto done
		}
		end++
	}
done:
	for end > 0 {
		if f, err := strconv.ParseFloat(s[:end], 64); err == nil {
			return f, true
		}
		end--
	}
	if strings.HasPrefix(s, "Infinity") || strings.HasPrefix(s, "+Infinity") {
		return math.Inf(1), true
	}
	if strings.HasPrefix(s, "-Infinity") {
		return math.Inf(-1), true
	}
	return 0, false
}
