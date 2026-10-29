package shared

import "strings"

func ShQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
func PsQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// KV 保序的 env 键值（JS Object.entries 顺序）。
type KV struct{ K, V string }

// TerminalLine mirrors terminalLine。
func TerminalLine(command string, args []string, env []KV, platform string) string {
	var b strings.Builder
	q := ShQuote
	if platform == "win32" {
		q = PsQuote
		for _, e := range env {
			b.WriteString("$env:" + e.K + "=" + PsQuote(e.V) + "; ")
		}
	} else {
		for _, e := range env {
			b.WriteString(e.K + "=" + ShQuote(e.V) + " ")
		}
	}
	parts := []string{command}
	for _, a := range args {
		parts = append(parts, q(a))
	}
	b.WriteString(strings.Join(parts, " "))
	return b.String()
}
