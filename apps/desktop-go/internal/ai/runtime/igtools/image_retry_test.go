package igtools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 服务暂时出错（5xx）：自动重试，第三次成功
func TestImageRetriesTransientErrors(t *testing.T) {
	d, calls, _ := imageSetup(t, "amux/m", nil, func(w http.ResponseWriter, _ *http.Request, n int) {
		if n < 3 {
			w.WriteHeader(503)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "busy"}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(png)}}})
	})
	out, err := d.Execute(context.Background(), u.NewObj("prompt", "x"), tools.ExecContext{})
	if err != nil || len(*calls) != 3 || out.(*u.Obj).Get("retries") != float64(2) {
		t.Fatalf("err=%v calls=%d out=%v", err, len(*calls), out)
	}
}

// 鉴权 / 参数错误：不重试
func TestImageNoRetryOnClientError(t *testing.T) {
	d, calls, _ := imageSetup(t, "amux/m", nil, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(401)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "bad key"}})
	})
	if _, err := d.Execute(context.Background(), u.NewObj("prompt", "x"), tools.ExecContext{}); err == nil || len(*calls) != 1 {
		t.Fatalf("err=%v calls=%d", err, len(*calls))
	}
}

// 上游一直失败：重试 ImageRetries 次后照常报错
func TestImageRetriesGiveUp(t *testing.T) {
	d, calls, _ := imageSetup(t, "amux/m", nil, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(500)
	})
	if _, err := d.Execute(context.Background(), u.NewObj("prompt", "x"), tools.ExecContext{}); err == nil || len(*calls) != 1+ImageRetries {
		t.Fatalf("err=%v calls=%d", err, len(*calls))
	}
}

func TestWithImageRetry(t *testing.T) {
	var waits []time.Duration
	d := ImageDeps{Sleep: func(w time.Duration) { waits = append(waits, w) }}
	n := 0
	// 429 带 Retry-After：按它等
	retries, err := d.withImageRetry(context.Background(), func() error {
		n++
		if n == 1 {
			return &imageHTTPError{Status: 429, RetryAfter: 3 * time.Second, msg: "slow down"}
		}
		return nil
	})
	if err != nil || retries != 1 || len(waits) != 1 || waits[0] != 3*time.Second {
		t.Fatalf("retries=%d err=%v waits=%v", retries, err, waits)
	}
	// 用户停止：不再试
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	n = 0
	if _, err := d.withImageRetry(ctx, func() error { n++; return &imageTransient{"x"} }); err == nil || n != 1 {
		t.Fatalf("retried after cancel: %d", n)
	}
	// 不是网络 / 上游的错误（没有图片模型、不支持改图）：不重试
	n = 0
	_, _ = d.withImageRetry(context.Background(), func() error { n++; return errors.New("no image model") })
	if n != 1 {
		t.Fatal("retried a non-transient error")
	}
	if !strings.Contains((&imageTransient{"task failed"}).Error(), "task failed") {
		t.Fatal("message")
	}
}
