package net

import (
	"regexp"
	"strconv"
	"strings"
)

// IsLoopbackHost is isLoopbackHost.
func IsLoopbackHost(host string) bool {
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

var hostHeaderRe = regexp.MustCompile(`^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$`)

// IsAllowedHostHeader is isAllowedHostHeader (DNS-rebinding guard).
func IsAllowedHostHeader(hostHeader string, port int) bool {
	if hostHeader == "" {
		return false
	}
	m := hostHeaderRe.FindStringSubmatchIndex(strings.TrimSpace(hostHeader))
	if m == nil {
		return false
	}
	s := strings.TrimSpace(hostHeader)
	name := strings.ToLower(stripBrackets(s[m[2]:m[3]]))
	if !IsLoopbackHost(name) {
		return false
	}
	if m[4] < 0 {
		return port == 80
	}
	n, err := strconv.ParseFloat(s[m[4]:m[5]], 64)
	return err == nil && n == float64(port)
}

// URLHost is urlHost.
func URLHost(host string) string {
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}
