package llm

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
)

// TestRetryParity replays scripts/parity/record-b5-retry.mjs (ai generateText
// with a mock model): calls made, delays requested and the final error.
func TestRetryParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/b5-retry.json")
	if err != nil {
		t.Fatal(err)
	}
	var scs []struct {
		Name       string
		MaxRetries *int
		Steps      []json.RawMessage
		Calls      int
		Delays     []float64
		Result     *string
		Error      *struct {
			Name, Message string
			Reason        *string
			Errors        []struct {
				Name, Message string
				StatusCode    *int
			}
		}
	}
	if err := json.Unmarshal(raw, &scs); err != nil {
		t.Fatal(err)
	}
	if len(scs) < 15 {
		t.Fatalf("only %d scenarios", len(scs))
	}
	for _, sc := range scs {
		t.Run(sc.Name, func(t *testing.T) {
			calls := 0
			delays := []float64{}
			o := RetryOptions{MaxRetries: sc.MaxRetries, Sleep: func(_ context.Context, ms float64) error {
				delays = append(delays, ms)
				return nil
			}}
			res, err := Retry(context.Background(), o, func() (string, error) {
				var st struct {
					Status    int
					Headers   map[string]string
					Retryable *bool
					Plain     string
				}
				s := sc.Steps[calls]
				calls++
				if string(s) == `"ok"` {
					return "ok", nil
				}
				_ = json.Unmarshal(s, &st)
				if st.Plain != "" {
					return "", errors.New(st.Plain)
				}
				r := st.Status == 429 || st.Status >= 500
				if st.Retryable != nil {
					r = *st.Retryable
				}
				code := st.Status
				return "", &APICallError{Message: "HTTP " + itoa(code), URL: "http://x/v1", StatusCode: code, ResponseHeaders: st.Headers, IsRetryable: r}
			})
			if calls != sc.Calls {
				t.Errorf("calls %d want %d", calls, sc.Calls)
			}
			if len(sc.Delays) == 0 {
				sc.Delays = []float64{}
			}
			if !reflect.DeepEqual(delays, sc.Delays) {
				t.Errorf("delays %v want %v", delays, sc.Delays)
			}
			if sc.Error == nil {
				if err != nil || res != *sc.Result {
					t.Errorf("got %q, %v want %q", res, err, *sc.Result)
				}
				return
			}
			if err == nil {
				t.Fatalf("no error, want %s", sc.Error.Name)
			}
			got := err.Error()
			var ae *APICallError
			var re0 *RetryError
			if errors.As(err, &re0) {
				got = re0.Message
			} else if errors.As(err, &ae) {
				got = ae.Message
			}
			if got != sc.Error.Message {
				t.Errorf("message %q want %q", got, sc.Error.Message)
			}
			var re *RetryError
			switch sc.Error.Name {
			case "AI_RetryError":
				if !errors.As(err, &re) {
					t.Fatalf("want RetryError, got %T", err)
				}
				if re.Reason != *sc.Error.Reason || len(re.Errors) != len(sc.Error.Errors) {
					t.Errorf("reason %s/%d want %s/%d", re.Reason, len(re.Errors), *sc.Error.Reason, len(sc.Error.Errors))
				}
			case "AI_APICallError":
				if _, ok := err.(*APICallError); !ok {
					t.Errorf("want APICallError, got %T", err)
				}
			default:
				if _, ok := err.(*APICallError); ok || errors.As(err, &re) {
					t.Errorf("want plain error, got %T", err)
				}
			}
		})
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
