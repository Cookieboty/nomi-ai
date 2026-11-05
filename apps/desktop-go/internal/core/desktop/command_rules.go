package desktop

// command_rules.go：命令白名单——用户在确认卡片上勾「以后这类命令不再问」，记下命令的前缀
// （如 `pnpm test`、`go test`、`git status`），之后 workspace_run 跑以它开头的命令直接执行。
//
// 只收「简单命令」：没有管道、重定向、命令替换、多条串联（允许开头一个 `cd 子目录 &&`）；
// 前缀 = 程序名 + 子命令（第二个词是普通单词时），只有程序名的（make、ls）就是程序名本身；
// `pnpm run build` 这类跑脚本的带上脚本名（只记「pnpm run」太宽）。
// 删文件、提权、跑任意脚本、联网下载、对外发布 / 推送、读凭据这类永远不进白名单，也不会被白名单放行
// （command_class.go 的确定性分类为 credential / never / external 的一律不认）。

import (
	"regexp"
	"slices"
	"strings"
)

// MaxCommandRules：最多记几条（超过时丢最早的）
const MaxCommandRules = 100

var (
	// 出现就不是简单命令：串联、管道、重定向、命令替换、变量展开、通配、后台、换行
	unsafeShell = regexp.MustCompile("[;&|<>`$*?(){}\\[\\]!\\\\\\n\\r]")
	// 开头的 `cd 子目录 && `：只认工作区里的相对路径（不以 / 或 ~ 开头，不含 ..）
	leadingCd  = regexp.MustCompile(`^cd\s+([A-Za-z0-9._\-/]+)\s*&&\s*`)
	ruleWord   = regexp.MustCompile(`^[a-z][a-z0-9:_\-]*$`)
	programRE  = regexp.MustCompile(`^[a-z][a-z0-9._\-+]*$`)
	ruleQuoted = regexp.MustCompile(`"[^"]*"|'[^']*'`)
)

// 永远不进白名单的程序：删改文件与权限、提权、任意执行、联网、进程与系统
var neverRulePrograms = []string{
	"rm", "rmdir", "mv", "cp", "dd", "mkfs", "shred", "truncate", "chmod", "chown", "chgrp", "ln",
	"sudo", "su", "doas", "env", "command", "exec", "eval", "xargs", "nohup", "time", "watch", "timeout",
	"sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd", "osascript",
	"node", "deno", "python", "python3", "ruby", "perl", "php", "lua", "java",
	"curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp",
	"kill", "killall", "pkill", "shutdown", "reboot", "launchctl", "systemctl", "crontab", "open", "start",
	"security", "defaults", "diskutil", "tee", "find", "sed", "awk", "npx", "pnpx", "bunx", "dlx", "gh",
}

// 程序 → 永远不进白名单的子命令（会改远端、改历史、删工作区改动、装东西、跑任意脚本的）
var neverRuleSubcommands = map[string][]string{
	"git": {"push", "reset", "clean", "checkout", "switch", "restore", "rebase", "merge", "rm", "mv", "filter-branch",
		"filter-repo", "gc", "prune", "reflog", "stash", "commit", "tag", "remote", "config", "submodule", "worktree",
		"branch", "cherry-pick", "revert", "am", "apply", "pull", "fetch", "clone", "init", "update-ref", "replace"},
	"npm":    {"publish", "unpublish", "exec", "x", "install", "i", "ci", "add", "uninstall", "remove", "rm", "link", "login", "logout", "token", "owner", "access", "deprecate", "dist-tag", "config", "set", "init", "create"},
	"pnpm":   {"publish", "exec", "dlx", "install", "i", "add", "remove", "rm", "uninstall", "link", "login", "logout", "config", "env", "setup", "self-update", "create", "init", "store", "patch", "patch-commit"},
	"yarn":   {"publish", "exec", "dlx", "install", "add", "remove", "link", "login", "logout", "config", "npm", "set", "create", "init", "plugin"},
	"bun":    {"x", "exec", "add", "install", "i", "remove", "rm", "link", "publish", "create", "init", "upgrade", "pm", "patch"},
	"cargo":  {"publish", "install", "uninstall", "login", "logout", "owner", "yank", "add", "remove", "new", "init", "run"},
	"go":     {"install", "get", "run", "generate", "env", "clean", "mod", "work", "tool"},
	"docker": {"rm", "rmi", "push", "login", "logout", "run", "exec", "system", "volume", "network", "kill", "stop", "compose"},
	"brew":   {"install", "uninstall", "remove", "upgrade", "update", "tap", "untap", "link", "unlink", "cleanup", "services"},
	"pip":    {"install", "uninstall", "download"},
	"pip3":   {"install", "uninstall", "download"},
}

// 跑 package.json 脚本的子命令：规则带上脚本名
var scriptRunners = map[string][]string{"npm": {"run", "run-script"}, "pnpm": {"run"}, "yarn": {"run"}, "bun": {"run"}}

// commandWords：去掉开头的 `cd 子目录 &&` 后的词；不是简单命令时 ok=false
func commandWords(cmd string) ([]string, bool) {
	c := strings.TrimSpace(cmd)
	if m := leadingCd.FindStringSubmatch(c); m != nil {
		dir := m[1]
		if strings.HasPrefix(dir, "/") || strings.Contains(dir, "..") {
			return nil, false
		}
		c = c[len(m[0]):]
	}
	if c == "" || unsafeShell.MatchString(c) {
		return nil, false
	}
	// 引号里的参数可以有空格，但引号不能出现在程序名与子命令里（下面按词比对）
	plain := ruleQuoted.ReplaceAllString(c, "x")
	if strings.ContainsAny(plain, `"'`) {
		return nil, false
	}
	return strings.Fields(c), true
}

// CommandRuleOf：这条命令能记成的白名单前缀；不能记（不是简单命令、危险程序 / 子命令、分类为对外 / 凭据）时 ok=false
func CommandRuleOf(cmd string) (string, bool) {
	w, ok := commandWords(cmd)
	if !ok || len(w) == 0 {
		return "", false
	}
	if cls := ClassifyCommand(cmd); cls != "" {
		return "", false
	}
	prog := w[0]
	if !programRE.MatchString(prog) || slices.Contains(neverRulePrograms, prog) {
		return "", false
	}
	if len(w) == 1 {
		return prog, true
	}
	sub := w[1]
	// 第二个词是选项或路径：只记程序名太宽，不给记
	if !ruleWord.MatchString(sub) {
		return "", false
	}
	if slices.Contains(neverRuleSubcommands[prog], sub) {
		return "", false
	}
	if slices.Contains(scriptRunners[prog], sub) {
		if len(w) < 3 || !ruleWord.MatchString(w[2]) {
			return "", false
		}
		return prog + " " + sub + " " + w[2], true
	}
	return prog + " " + sub, true
}

// MatchCommandRule：这条命令记成的规则在白名单里。规则都由 CommandRuleOf 产生，
// 比对用同一套检查：记不进来的命令（危险、复杂）也不会被白名单放行
func MatchCommandRule(cmd string, rules []string) (string, bool) {
	if len(rules) == 0 {
		return "", false
	}
	own, ok := CommandRuleOf(cmd)
	if !ok || !slices.Contains(rules, own) {
		return "", false
	}
	return own, true
}

// NormalizeCommandRule：设置里存的规则（去重前清洗）；不合法返回 ""
func NormalizeCommandRule(r string) string {
	r = strings.Join(strings.Fields(r), " ")
	got, ok := CommandRuleOf(r)
	if !ok || got != r {
		return ""
	}
	return r
}
