package server

// 重连策略（docs/development/gateway.md）：
// 临时性错误先在同一个 Key 上退避重连，每个 Key 重连 KeyRetries 次（只有一个 Key 时 SingleKeyRetries 次），
// 同一家累计失败 ProviderMaxFailures 次换同一个模型的下一家；401 / 403 不重连直接换 Key。

import (
	"context"
	"math"
	"math/rand"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	KeyRetries          = 3
	SingleKeyRetries    = 5
	ProviderMaxFailures = 10
	MaxTotalAttempts    = 30
	RetryBaseDelayMs    = 500
	RetryMaxDelayMs     = 8_000
	RetryAfterMaxMs     = 30_000
)

var transientStatus = map[int]bool{408: true, 429: true, 500: true, 502: true, 503: true, 504: true, 529: true}

// IsTransientFailure：值得在同一个 Key 上退避重连的失败
func IsTransientFailure(status int, upstreamStatus *int, network bool, errorKind string) bool {
	if errorKind == "local-limit" {
		return false
	}
	if network {
		return true
	}
	s := status
	if upstreamStatus != nil {
		s = *upstreamStatus
	}
	return transientStatus[s]
}

// KeyRetryLimit：这个 Key 最多重连几次（所在供应商只有一个 Key 时更多）
func KeyRetryLimit(keysOfProvider int) int {
	if keysOfProvider <= 1 {
		return SingleKeyRetries
	}
	return KeyRetries
}

var secondsRe = regexp.MustCompile(`^\d+(\.\d+)?$`)

// RetryAfterMs：Retry-After 的秒数或 HTTP 日期；解析不了返回 -1
func RetryAfterMs(raw string, now time.Time) float64 {
	v := strings.TrimSpace(raw)
	if v == "" {
		return -1
	}
	if secondsRe.MatchString(v) {
		f, _ := strconv.ParseFloat(v, 64)
		return math.Round(f * 1000)
	}
	if t, err := http.ParseTime(v); err == nil {
		return math.Max(0, float64(t.Sub(now).Milliseconds()))
	}
	return -1
}

// RetryDelayMs：第 retry 次重连（从 1 开始）前等多久；base <= 0 时不等（测试）
func RetryDelayMs(retry int, retryAfter *string, base float64, random func() float64) float64 {
	if base <= 0 {
		return 0
	}
	if retryAfter != nil {
		if h := RetryAfterMs(*retryAfter, time.Now()); h >= 0 {
			return math.Min(h, RetryAfterMaxMs)
		}
	}
	exp := math.Min(base*math.Pow(2, float64(max(0, retry-1))), RetryMaxDelayMs)
	if random == nil {
		random = rand.Float64
	}
	return math.Round(exp * (0.8 + 0.4*random()))
}

// waitRetry：可中止的等待；等待期间每 5 秒调一次 onTick（流式给客户端发保活）。被中止返回 false
func waitRetry(ctx context.Context, ms float64, onTick func()) bool {
	if ctx.Err() != nil {
		return false
	}
	if ms <= 0 {
		return true
	}
	timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer timer.Stop()
	var tick <-chan time.Time
	if onTick != nil {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		tick = t.C
	}
	for {
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return true
		case <-tick:
			onTick()
		}
	}
}
