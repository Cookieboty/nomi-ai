// Package upstream mirrors apps/desktop-electron/internal/gateway/src/{ingress,fixes,customTools,
// responseFixes,upstream,timeouts,cooldown,limits}.ts.
package upstream

import (
	"regexp"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Ingress is Ingress.
type Ingress struct {
	Wire        string
	Model       *string
	Stream      bool
	CountTokens bool
}

// JSON is the TS object shape.
func (i *Ingress) JSON() any {
	if i == nil {
		return nil
	}
	o := u.NewObj("wire", i.Wire)
	if i.Model != nil {
		o.Set("model", *i.Model)
	}
	if i.Stream {
		o.Set("stream", true)
	}
	if i.CountTokens {
		o.Set("countTokens", true)
	}
	return o
}

var geminiRe = regexp.MustCompile(`/models/(.+):(generateContent|streamGenerateContent|countTokens)$`)
var trailingSlashes = regexp.MustCompile(`/+$`)

// IngressFromPath is ingressFromPath.
func IngressFromPath(url string) *Ingress {
	path := url
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	path = trailingSlashes.ReplaceAllString(path, "")
	if g := geminiRe.FindStringSubmatch(path); g != nil {
		model := g[1]
		if d, err := u.DecodeURIComponent(model); err == nil {
			model = d
		}
		return &Ingress{Wire: "gemini", Model: &model, Stream: g[2] == "streamGenerateContent", CountTokens: g[2] == "countTokens"}
	}
	switch {
	case strings.HasSuffix(path, "/messages/count_tokens"):
		return &Ingress{Wire: "messages", CountTokens: true}
	case strings.HasSuffix(path, "/messages"):
		return &Ingress{Wire: "messages"}
	case strings.HasSuffix(path, "/responses"):
		return &Ingress{Wire: "responses"}
	case strings.HasSuffix(path, "/chat/completions"):
		return &Ingress{Wire: "chat"}
	}
	return nil
}

// GeminiModelPath is geminiModelPath.
func GeminiModelPath(model string) string {
	model = strings.TrimPrefix(model, "models/")
	parts := strings.Split(model, "/")
	for i, p := range parts {
		parts[i] = u.EncodeURIComponent(p)
	}
	return strings.Join(parts, "/")
}
