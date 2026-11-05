package desktop

// 命令的确定性分类（用例在 testdata/command-class.json）。
// credential：读凭据 → 后台一律停下来等人；never：合并、发布、删仓库、改密钥、强推；external：对外副作用（需 L4）。

import (
	"regexp"
	"strings"
)

var (
	cmdSep    = regexp.MustCompile(`&&|\|\||;|\||\n`)
	envAssign = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	credFiles = regexp.MustCompile(`(\.config/gh/hosts\.yml|\.git-credentials|\.netrc|_netrc)\b`)
	wordRE    = regexp.MustCompile(`"([^"]*)"|'([^']*)'|(\S+)`)
	repoRoot  = regexp.MustCompile(`/repos/[^/]+/[^/]+/?$`)
	secPw     = regexp.MustCompile(`^(find-(generic|internet)-password|dump-keychain|export)$`)
)

var classRank = map[string]int{"external": 1, "never": 2, "credential": 3}

func cmdWords(seg string) []string {
	out := []string{}
	for _, m := range wordRE.FindAllStringSubmatch(seg, -1) {
		switch {
		case m[1] != "" || strings.HasPrefix(m[0], `"`):
			out = append(out, m[1])
		case m[2] != "" || strings.HasPrefix(m[0], `'`):
			out = append(out, m[2])
		default:
			out = append(out, m[3])
		}
	}
	return out
}

func in(x string, xs ...string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func classifySegment(seg string) string {
	if credFiles.MatchString(seg) {
		return "credential"
	}
	w := cmdWords(strings.TrimSpace(seg))
	for len(w) > 0 && (envAssign.MatchString(w[0]) || in(w[0], "sudo", "env", "command")) {
		w = w[1:]
	}
	if len(w) == 0 {
		return ""
	}
	parts := strings.Split(w[0], "/")
	bin := parts[len(parts)-1]
	a, b := "", ""
	if len(w) > 1 {
		a = w[1]
	}
	if len(w) > 2 {
		b = w[2]
	}
	rest := w[1:]
	has := func(flags ...string) bool {
		for _, x := range rest {
			for _, f := range flags {
				if x == f || strings.HasPrefix(x, f+"=") {
					return true
				}
			}
		}
		return false
	}
	if bin == "security" && secPw.MatchString(a) {
		return "credential"
	}
	switch bin {
	case "gh":
		switch {
		case a == "auth" && (b == "token" || (b == "status" && has("--show-token", "-t"))):
			return "credential"
		case a == "pr" && b == "merge":
			return "never"
		case a == "release" && in(b, "create", "delete", "upload", "edit"):
			return "never"
		case a == "repo" && in(b, "delete", "archive", "edit", "rename"):
			return "never"
		case a == "repo" && in(b, "create", "fork"):
			return "external"
		case a == "secret" || a == "variable":
			if in(b, "set", "delete", "remove") {
				return "never"
			}
			return ""
		case a == "issue" && in(b, "create", "comment", "close", "reopen", "edit", "delete", "lock", "transfer"):
			return "external"
		case a == "pr" && in(b, "create", "comment", "review", "close", "reopen", "edit", "ready"):
			return "external"
		case a == "workflow" && in(b, "run", "enable", "disable"):
			return "external"
		case a == "run" && in(b, "rerun", "cancel", "delete"):
			return "external"
		case a == "api":
			method := ""
			for i, x := range rest {
				if x == "-X" || x == "--method" {
					if i+1 < len(rest) {
						method = strings.ToUpper(rest[i+1])
					}
					break
				}
				if strings.HasPrefix(x, "-X") || strings.HasPrefix(x, "--method=") {
					method = strings.ToUpper(strings.TrimPrefix(strings.TrimPrefix(x, "--method="), "-X"))
					break
				}
			}
			if method == "DELETE" {
				for _, x := range rest {
					if repoRoot.MatchString(x) {
						return "never"
					}
				}
			}
			if strings.Contains(strings.Join(rest, " "), "merge") && method != "" && method != "GET" {
				return "never"
			}
			if in(method, "POST", "PATCH", "PUT", "DELETE") {
				return "external"
			}
			if method == "" && has("-f", "-F", "--field", "--raw-field", "--input") {
				return "external"
			}
			return ""
		}
		return ""
	case "git":
		if a == "credential" && in(b, "fill", "get") {
			return "credential"
		}
		if a == "push" {
			if has("--force", "-f", "--force-with-lease", "--mirror", "--delete", "-d") {
				return "never"
			}
			for _, x := range rest {
				if strings.HasPrefix(x, "+") {
					return "never"
				}
			}
			return "external"
		}
	}
	return ""
}

// ClassifyCommand：整条命令里最严重的一类；"" = 不在分类里
func ClassifyCommand(command string) string {
	worst := ""
	for _, seg := range cmdSep.Split(command, -1) {
		if c := classifySegment(seg); c != "" && classRank[c] > classRank[worst] {
			worst = c
		}
	}
	return worst
}
