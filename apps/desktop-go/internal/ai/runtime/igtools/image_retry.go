package igtools

// image_retry.go：生图失败时自动重试。
// - 生成（提交 + 轮询）：网络错误、超时、429、5xx、异步任务失败、返回里没有图 → 再试，最多 ImageRetries 次，
//   间隔按 imageBackoff 递增；429 / 503 给了 Retry-After（不超过 30 秒）就按它等。
// - 下载：图已经生成好、只是下载失败 → 只重试下载，不重新生成。
// - 不重试：鉴权 / 参数 / 内容审核这类 4xx、没有图片模型、模型不支持改图、用户停止（ctx 取消）。

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

// ImageRetries：失败后最多再试几次
var ImageRetries = 2

var imageBackoff = []time.Duration{2 * time.Second, 6 * time.Second}

// imageHTTPError：生图服务 / 图片下载返回的非 2xx
type imageHTTPError struct {
	Status     int
	RetryAfter time.Duration
	msg        string
}

func (e *imageHTTPError) Error() string { return e.msg }

// imageTransient：上游说失败了，但再试一次可能就好（异步任务失败、返回里没有图、轮询超时）
type imageTransient struct{ msg string }

func (e *imageTransient) Error() string { return e.msg }

func retryAfterOf(h http.Header) time.Duration {
	v := h.Get("Retry-After")
	if v == "" {
		return 0
	}
	if s, err := strconv.Atoi(v); err == nil && s > 0 {
		return time.Duration(s) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

// imageRetryable：这个错误值不值得再试
func imageRetryable(ctx context.Context, err error) bool {
	if err == nil || ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return false
	}
	var he *imageHTTPError
	if errors.As(err, &he) {
		return he.Status == 408 || he.Status == 425 || he.Status == 429 || he.Status >= 500
	}
	var tr *imageTransient
	if errors.As(err, &tr) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return true
	}
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, context.DeadlineExceeded)
}

// retryWait：第 n 次重试前等多久
func retryWait(n int, err error) time.Duration {
	var he *imageHTTPError
	if errors.As(err, &he) && he.RetryAfter > 0 && he.RetryAfter <= 30*time.Second {
		return he.RetryAfter
	}
	if n < len(imageBackoff) {
		return imageBackoff[n]
	}
	return imageBackoff[len(imageBackoff)-1]
}

// withImageRetry：f 失败且可以重试时等一会儿再试；返回重试了几次
func (d ImageDeps) withImageRetry(ctx context.Context, f func() error) (int, error) {
	sleep := d.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	err := f()
	n := 0
	for ; n < ImageRetries && imageRetryable(ctx, err); n++ {
		sleep(retryWait(n, err))
		if ctx.Err() != nil {
			return n, err
		}
		err = f()
	}
	return n, err
}
