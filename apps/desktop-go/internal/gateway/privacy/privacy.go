package privacy

import (
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

// jsHostname is `new URL(raw).hostname` (IPv6 keeps its brackets).
func jsHostname(raw string) (string, bool) {
	pu, err := gnet.ParseURL(raw)
	if err != nil {
		return "", false
	}
	h := pu.Hostname()
	if strings.HasPrefix(pu.Host, "[") {
		h = "[" + h + "]"
	}
	return h, true
}

// IsLocalCandidate is isLocalCandidate.
func IsLocalCandidate(c *cand.Candidate) bool {
	raw := c.Provider.URL(c.Wire)
	if raw == "" {
		return false
	}
	host, ok := jsHostname(raw)
	if !ok {
		return false
	}
	return gnet.IsLoopbackHost(host) || gnet.IsPrivateHost(host)
}

// KnownSecrets is knownSecrets.
func KnownSecrets(cfg *config.GatewayConfig) []Entry {
	var out []Entry
	// 按下标取，不按值拷贝 RuntimeProvider：拷贝会读它的 memo 指针，在途请求同时在
	// Memo() 里写它（同一份 cfg），race 检测会报。
	for i := range cfg.Providers {
		for _, k := range cfg.Providers[i].Keys {
			out = append(out, Entry{Kind: "API_KEY", Value: k.Value})
		}
	}
	for _, c := range cfg.ClientValues() {
		if c != nil {
			out = append(out, Entry{Kind: "TOKEN", Value: c.Token})
		}
	}
	if cfg.LegacyToken != "" {
		out = append(out, Entry{Kind: "TOKEN", Value: cfg.LegacyToken})
	}
	if cfg.Privacy != nil {
		for _, k := range cfg.Privacy.Known {
			out = append(out, Entry{Kind: k.Kind, Value: k.Value})
		}
	}
	kept := out[:0]
	for _, e := range out {
		if e.Value != "" {
			kept = append(kept, e)
		}
	}
	return kept
}

func optsOf(p *config.PrivacyConfig) MaskOptions {
	o := MaskOptions{Key: p.Key, Strict: p.Strict, Actions: p.Actions}
	if len(p.Allow) > 0 {
		o.Allow = set(p.Allow...)
	}
	return o
}

// PreviewPrivacy is previewPrivacy.
func PreviewPrivacy(text string, p *config.PrivacyConfig) (string, []*RedactionHit) {
	store := NewSecretStore()
	store.SetKey(p.Key)
	store.SetShape(p.Shape)
	var known []Entry
	for _, k := range p.Known {
		known = append(known, Entry{Kind: k.Kind, Value: k.Value})
	}
	store.SetKnown(known)
	r := MaskText(text, store, optsOf(p))
	return r.Text, r.Hits
}

// GatewayPrivacy is GatewayPrivacy.
//
// Node 单线程，Store 的查找→分配占位→更新索引天然是原子的；Go 的 net/http 每个连接一个
// goroutine，并发请求会同时 Mask，配置更新也会 Configure 同一个 Store，裸 map / 索引并发读写
// 会让进程直接 fatal（#201）。mu 把 Configure / Mask 整段事务串起来；Mask 只做内存里的
// 遍历替换，不碰网络，持锁时间与正文大小成正比。Store 只应在持 mu 时访问。
type GatewayPrivacy struct {
	mu    sync.Mutex
	Store *SecretStore
}

// NewGatewayPrivacy is new GatewayPrivacy().
func NewGatewayPrivacy() *GatewayPrivacy { return &GatewayPrivacy{Store: NewSecretStore()} }

// Configure is configure(cfg).
func (g *GatewayPrivacy) Configure(cfg *config.GatewayConfig) {
	g.mu.Lock()
	defer g.mu.Unlock()
	p := cfg.Privacy
	if p == nil || !p.Enabled {
		g.Store.Clear()
		return
	}
	g.Store.SetKey(p.Key)
	g.Store.SetShape(p.Shape)
	g.Store.SetKnown(KnownSecrets(cfg))
}

// Applies is applies(cfg, c).
func (g *GatewayPrivacy) Applies(cfg *config.GatewayConfig, c *cand.Candidate) bool {
	return cfg.Privacy != nil && cfg.Privacy.Enabled && (cfg.Privacy.Local || !IsLocalCandidate(c))
}

// Mask is mask(cfg, body).
func (g *GatewayPrivacy) Mask(cfg *config.GatewayConfig, body any) MaskResult {
	// defer 解锁：脱敏 panic 由网关 recover 后拒绝该请求，锁不能留在持有状态卡住后续请求。
	g.mu.Lock()
	defer g.mu.Unlock()
	return MaskBody(body, g.Store, optsOf(cfg.Privacy))
}
