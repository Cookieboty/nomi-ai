package extensions

import (
	"regexp"
	"strings"
)

// 以下三项移植自 packages/core/src/cli/slashDiscovery.ts（DENY / DENY_DIR / parseFrontmatter）。
// TODO(cli-batch): cli 包移植后改为引用那边的实现，避免两份。

var Deny = regexp.MustCompile(`(?i)(^|/)(\.credentials.*|auth\.json|\.env.*|.*\.key|.*\.pem|.*\.(p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.dockercfg|kubeconfig|credentials(\.json)?|settings(\.local)?\.json|config\.toml|\.claude\.json|service[-_]?account.*\.json|.*\.tfvars(\.json)?|secrets?(\.[\w-]+)?\.(json|ya?ml|toml|env|txt)|\.htpasswd|.*\.kdbx|history\.jsonl|\.[\w-]*_history)$`)

var DenyDir = regexp.MustCompile(`(?i)(^|/)(\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.docker|\.git|\.password-store|Keychains)(/|$)|(^|/)\.config/(gcloud|gh|git)(/|$)`)

var fmStart = regexp.MustCompile(`^---\r?\n`)
var fmEnd = regexp.MustCompile(`^---\s*$`)
var fmKV = regexp.MustCompile(`^([A-Za-z_][\w-]*):\s*(.*)$`)
var blockInd = regexp.MustCompile(`^[>|][+-]?$`)
var contLine = regexp.MustCompile(`^\s+\S`)
var dashPrefix = regexp.MustCompile(`^-\s+`)

func ParseFrontmatter(text string) (map[string]string, string) {
	t := strings.TrimPrefix(text, "\uFEFF")
	if !fmStart.MatchString(t) {
		return map[string]string{}, t
	}
	lines := lineSplit.Split(t, -1)
	end := -1
	for i := 1; i < len(lines); i++ {
		if fmEnd.MatchString(lines[i]) {
			end = i
			break
		}
	}
	if end < 0 {
		return map[string]string{}, t
	}
	meta := map[string]string{}
	for i := 1; i < end; i++ {
		m := fmKV.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		key := strings.ToLower(m[1])
		val := m[2]
		tv := jsTrim(val)
		if blockInd.MatchString(tv) || tv == "" {
			parts := []string{}
			for i+1 < end && contLine.MatchString(lines[i+1]) {
				i++
				parts = append(parts, dashPrefix.ReplaceAllString(jsTrim(lines[i]), ""))
			}
			sep := " "
			if strings.HasPrefix(tv, "|") {
				sep = "\n"
			}
			val = strings.Join(parts, sep)
		}
		meta[key] = unquote(jsTrim(val))
	}
	return meta, strings.Join(lines[end+1:], "\n")
}
