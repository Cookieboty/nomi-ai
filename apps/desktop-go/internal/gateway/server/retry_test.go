package server

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func ip2(n int) *int { return &n }

func TestRetryPolicy(t *testing.T) {
	for _, s := range []int{408, 429, 500, 502, 503, 504, 529} {
		if !IsTransientFailure(502, ip2(s), false, "") {
			t.Fatalf("%d should be transient", s)
		}
	}
	for _, s := range []int{400, 401, 403, 404, 422} {
		if IsTransientFailure(s, ip2(s), false, "") {
			t.Fatalf("%d should not be transient", s)
		}
	}
	if !IsTransientFailure(502, nil, true, "") || IsTransientFailure(429, nil, false, "local-limit") {
		t.Fatal("network / local-limit")
	}
	if KeyRetryLimit(1) != 5 || KeyRetryLimit(3) != 3 {
		t.Fatal("key retry limit")
	}
	mid := func() float64 { return 0.5 }
	for i, want := range []float64{500, 1000, 2000, 4000, RetryMaxDelayMs} {
		if got := RetryDelayMs(i+1, nil, RetryBaseDelayMs, mid); got != want {
			t.Fatalf("retry %d: %v want %v", i+1, got, want)
		}
	}
	ra := "3"
	if RetryDelayMs(1, &ra, RetryBaseDelayMs, mid) != 3000 {
		t.Fatal("retry-after")
	}
	big := "600"
	if RetryDelayMs(1, &big, RetryBaseDelayMs, mid) != RetryAfterMaxMs {
		t.Fatal("retry-after cap")
	}
	if RetryDelayMs(1, &ra, 0, mid) != 0 {
		t.Fatal("base 0 = no wait")
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if RetryAfterMs(now.Add(2*time.Second).Format(http.TimeFormat), now) != 2000 {
		t.Fatal("http date")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if waitRetry(ctx, 10_000, nil) {
		t.Fatal("aborted wait")
	}
}
