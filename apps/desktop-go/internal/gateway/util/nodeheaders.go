package util

import (
	"net/http"
	"strings"
)

// Node's IncomingMessage drops duplicates of these (first wins).
var nodeDiscardDup = map[string]bool{
	"age": true, "authorization": true, "content-length": true, "content-type": true, "etag": true,
	"expires": true, "from": true, "host": true, "if-modified-since": true, "if-unmodified-since": true,
	"last-modified": true, "location": true, "max-forwards": true, "proxy-authorization": true,
	"referer": true, "retry-after": true, "server": true, "user-agent": true,
}

// NodeHeader is `req.headers[name]` for a lowercase name: duplicates joined
// with ", " ("; " for cookie), first-wins for Node's discard list; set-cookie
// yields its first entry (callers take v[0]). ok is false when absent.
func NodeHeader(h http.Header, name string) (string, bool) {
	vs := h.Values(name)
	if len(vs) == 0 {
		// Raw, non-canonical keys set directly in the map.
		for k, v := range h {
			if strings.EqualFold(k, name) {
				vs = append(vs, v...)
			}
		}
		if len(vs) == 0 {
			return "", false
		}
	}
	switch {
	case name == "set-cookie" || nodeDiscardDup[name]:
		return vs[0], true
	case name == "cookie":
		return strings.Join(vs, "; "), true
	}
	return strings.Join(vs, ", "), true
}
