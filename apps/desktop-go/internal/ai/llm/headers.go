package llm

import (
	"net/http"
	"sort"
	"strings"
)

// Version strings baked into the user-agent chain.
const (
	ProviderUtilsVersion = "5.0.58"  // @ai-sdk/provider-utils
	AIVersion            = "7.0.136" // ai (streamText / generateText)
)

// RuntimeUserAgent is getRuntimeEnvironmentUserAgent() ("node.js/<process.version>").
// The Go binary has no Node; it reports the Node version the goldens were
// recorded with (D-B5-P-2). Tests override it from the golden.
var RuntimeUserAgent = "node.js/v22.14.0"

// CombineHeaders is provider-utils combineHeaders (object spread: exact-case
// keys overwrite in place, new keys append, undefined overrides).
func CombineHeaders(sets ...[]Header) []Header {
	var out []Header
	for _, s := range sets {
		for _, h := range s {
			found := false
			for i := range out {
				if out[i].Name == h.Name {
					out[i] = h
					found = true
					break
				}
			}
			if !found {
				out = append(out, h)
			}
		}
	}
	return out
}

// H builds a defined header.
func H(name, value string) Header { return Header{Name: name, Value: value} }

// NormalizeHeaders is normalizeHeaders + `new Headers()` (lowercase keys,
// undefined dropped, last wins, values whitespace-trimmed). Ordered by key
// like Headers iteration.
func NormalizeHeaders(hs []Header) []Header {
	m := map[string]string{}
	for _, h := range hs {
		if h.Undefined {
			continue
		}
		m[strings.ToLower(h.Name)] = strings.Trim(h.Value, " \t\r\n")
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]Header, len(keys))
	for i, k := range keys {
		out[i] = H(k, m[k])
	}
	return out
}

// WithUserAgentSuffix is provider-utils withUserAgentSuffix.
func WithUserAgentSuffix(hs []Header, parts ...string) []Header {
	n := NormalizeHeaders(hs)
	cur := ""
	for _, h := range n {
		if h.Name == "user-agent" {
			cur = h.Value
		}
	}
	all := []string{}
	for _, p := range append([]string{cur}, parts...) {
		if p != "" {
			all = append(all, p)
		}
	}
	return NormalizeHeaders(append(n, H("user-agent", strings.Join(all, " "))))
}

// ExtractResponseHeaders is Object.fromEntries([...response.headers]).
func ExtractResponseHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for k, vs := range h {
		lk := strings.ToLower(k)
		if lk == "set-cookie" {
			out[lk] = vs[len(vs)-1]
			continue
		}
		out[lk] = strings.Join(vs, ", ")
	}
	return out
}

// HeaderValue reads a header (Record lookup by exact key).
func HeaderValue(hs []Header, name string) (string, bool) {
	for i := len(hs) - 1; i >= 0; i-- {
		if hs[i].Name == name && !hs[i].Undefined {
			return hs[i].Value, true
		}
	}
	return "", false
}
