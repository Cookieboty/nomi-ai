package privacy

import "regexp"

// JSRegexp compiles a JS regex source for matching over u.Projection
// (\s / \S rewritten for the projection; caller adds (?i) for /i).
func JSRegexp(src string) *regexp.Regexp { return re(src) }
