package privacy

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func racePrivacyCfg(gen int) *config.GatewayConfig {
	return &config.GatewayConfig{Privacy: &config.PrivacyConfig{
		Enabled: true,
		Key:     "race-key",
		Known: []config.KnownSecret{
			{Kind: "SECRET", Value: "nomi_review_dummy_alpha"},
			{Kind: "SECRET", Value: "nomi_review_dummy_beta"},
			{Kind: "SECRET", Value: fmt.Sprintf("nomi_review_dummy_gen_%04d", gen)},
		},
	}}
}

// #201：并发请求共用同一个 GatewayPrivacy.Store，Mask 里 findUnits 读索引、Assign 写
// byValue / byPlaceholder / index，Configure 还会重建索引。没有锁时 `go test -race` 报竞态，
// 运行期可能 concurrent map writes 直接 fatal。全部是合成样本，不含真实凭据。
func TestGatewayPrivacyConcurrentMaskConfigure(t *testing.T) {
	g := NewGatewayPrivacy()
	g.Configure(racePrivacyCfg(0))
	const workers, rounds = 16, 200
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				cfg := racePrivacyCfg(i)
				if w == 0 {
					g.Configure(cfg)
					continue
				}
				// 每次都带一个首次出现的已知值，逼 Assign 写共享 Store。
				fresh := fmt.Sprintf("nomi_review_dummy_gen_%04d", i)
				text := "alpha nomi_review_dummy_alpha beta nomi_review_dummy_beta fresh " + fresh + " end"
				body := u.NewObj("messages", []any{u.NewObj("role", "user", "content", text)})
				r := g.Mask(cfg, body)
				out := u.Stringify(r.Body)
				for _, secret := range []string{"nomi_review_dummy_alpha", "nomi_review_dummy_beta"} {
					if strings.Contains(out, secret) {
						t.Errorf("secret %q left in masked body: %s", secret, out)
						return
					}
				}
				// 每个请求的 Restore 只含本次映射，还原后与原文一致。
				for _, p := range r.Restore.Keys() {
					v, _ := r.Restore.Get(p)
					if !strings.Contains(text, v) {
						t.Errorf("restore has foreign value %q", v)
					}
					out = strings.ReplaceAll(out, p, v)
				}
				if !strings.Contains(out, text) {
					t.Errorf("mask→restore mismatch: %s", out)
				}
			}
		}(w)
	}
	wg.Wait()
}
