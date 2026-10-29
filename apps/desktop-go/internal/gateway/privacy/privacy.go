package privacy

import (
	"strings"

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
	for _, p := range cfg.Providers {
		for _, k := range p.Keys {
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
type GatewayPrivacy struct{ Store *SecretStore }

// NewGatewayPrivacy is new GatewayPrivacy().
func NewGatewayPrivacy() *GatewayPrivacy { return &GatewayPrivacy{Store: NewSecretStore()} }

// Configure is configure(cfg).
func (g *GatewayPrivacy) Configure(cfg *config.GatewayConfig) {
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
	return MaskBody(body, g.Store, optsOf(cfg.Privacy))
}
