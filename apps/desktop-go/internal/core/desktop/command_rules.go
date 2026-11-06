package desktop

// command_rules.go：命令白名单——用户在确认卡片上勾「以后这类命令不再问」，记下命令的前缀
// （如 `pnpm test`、`go test`、`git status`），之后 workspace_run 跑以它开头的命令直接执行。
//
// 只收「简单命令」：没有管道、重定向、命令替换、多条串联（允许开头一个 `cd 子目录 &&`）；
// 前缀 = 程序名 + 子命令，只认 ruleSubcommands 里列出的组合（白名单式）；本身就是测试 / 检查工具的
// （tsc、vitest、ls…）可以只有程序名；`pnpm run build` 这类跑脚本的带上脚本名（只记「pnpm run」太宽）。
// 带任意执行 / 写任意位置 / 换外部程序参数的不记也不放行；command_class.go 的确定性分类为
// credential / never / external 的一律不认。

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
	leadingCd = regexp.MustCompile(`^cd\s+([A-Za-z0-9._\-/]+)\s*&&\s*`)
	ruleWord  = regexp.MustCompile(`^[a-z][a-z0-9:_\-]*$`)
	programRE = regexp.MustCompile(`^[a-z][a-z0-9._\-+]*$`)
)

// 能记成规则的「程序 → 子命令」：只放行已知是测试 / 构建 / 检查 / 只读查询的组合（白名单式，没列的都不认）。
// 跑包脚本（pnpm run x、make x）本来就会执行仓库里的代码——这是用户勾选时认可的；但污染后会暂停白名单，见 permission_broker。
var ruleSubcommands = map[string][]string{
	"git":    {"status", "diff", "log", "show", "blame", "ls-files", "describe", "rev-parse", "shortlog"},
	"npm":    {"test", "t"},
	"pnpm":   {"test", "t", "build", "lint", "typecheck", "check", "format"},
	"yarn":   {"test", "build", "lint", "typecheck", "check"},
	"bun":    {"test"},
	"go":     {"test", "build", "vet", "fmt", "list", "version"},
	"cargo":  {"test", "build", "check", "clippy", "fmt", "doc"},
	"make":   {"test", "build", "lint", "check", "fmt", "format", "all", "typecheck"},
	"just":   {"test", "build", "lint", "check", "fmt"},
	"swift":  {"test", "build"},
	"dotnet": {"test", "build"},
	"mvn":    {"test", "verify", "compile"},
	"gradle": {"test", "build", "check"},
	"turbo":  {"run"},
}

// 只有程序名就能记的：本身就是测试 / 检查工具，参数照样过下面的危险参数检查
var ruleProgramsAlone = []string{"tsc", "eslint", "prettier", "vitest", "jest", "pytest", "ruff", "mypy", "gofmt", "golangci-lint", "ls", "pwd", "tree"}

// 任何规则命中后都不放行的参数：任意执行（-exec / -toolexec / -vettool / --exec / bisect run）、
// 写到任意位置（--output / -o 绝对路径）、换外部程序（-O / --open-files-in-pager / --ext-diff / --config / -c）
var unsafeRuleArgs = regexp.MustCompile(`^(-exec|--exec|-toolexec|--toolexec|-vettool|--vettool|-overlay|--output|--output-directory|-O|--open-files-in-pager|--ext-diff|--textconv|--config|-c|--upload-pack|--receive-pack)(=.*)?$|^-O.+|^--output=|^-o$`)

// 危险长选项：git 等用 parse-options 的程序接受唯一前缀缩写（`--outp=x` 即 `--output=x`），
// 所以 `--` 开头、名字是其中任一个前缀的参数也不放行（宁可多拦）
var unsafeLongOptions = []string{"--exec", "--toolexec", "--vettool", "--output", "--output-directory",
	"--open-files-in-pager", "--ext-diff", "--textconv", "--config", "--upload-pack", "--receive-pack"}

// unsafeRuleArg：参数（已按 shell 规则去掉引号）是危险参数
func unsafeRuleArg(a string) bool {
	if unsafeRuleArgs.MatchString(a) {
		return true
	}
	if !strings.HasPrefix(a, "--") {
		return false
	}
	name, _, _ := strings.Cut(a, "=")
	if len(name) < 3 {
		return false // 单独的 `--`：参数结束标记
	}
	for _, o := range unsafeLongOptions {
		if strings.HasPrefix(o, name) {
			return true
		}
	}
	return false
}

// 跑 package.json 脚本的子命令：规则带上脚本名
var scriptRunners = map[string][]string{"npm": {"run", "run-script"}, "pnpm": {"run"}, "yarn": {"run"}, "bun": {"run"}, "turbo": {"run"}}

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
	return shellWords(c)
}

// shellWords：按 shell 实际交给程序的 argv 切词。unsafeShell 已经排除了 `$`、反引号、反斜杠、通配等
// 所有展开与转义，剩下的语法只有单 / 双引号：引号段与相邻的普通段拼成同一个词、去掉引号——
// 与 sh -c 的结果一致（`"-exec=x"`、`'-'exec=x`、`--out"put"=x` 都还原成程序看到的参数）。
// 引号不配对时 ok=false。Windows 上程序自己按同样的规则去引号，危险参数检查看到的也是去引号后的值。
func shellWords(c string) ([]string, bool) {
	var words []string
	var cur strings.Builder
	inWord := false
	var quote rune
	for _, r := range c {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote, inWord = r, true
		case r == ' ' || r == '\t':
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if quote != 0 {
		return nil, false
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words, true
}

// CommandRuleOf：这条命令能记成的白名单前缀；不在允许的程序 / 子命令里、带危险参数、不是简单命令、
// 分类为对外 / 凭据时 ok=false
func CommandRuleOf(cmd string) (string, bool) {
	w, ok := commandWords(cmd)
	if !ok || len(w) == 0 {
		return "", false
	}
	// 原文与去引号后的命令都过一遍确定性分类：引号不能挡住凭据路径 / 对外操作的识别
	if ClassifyCommand(cmd) != "" || ClassifyCommand(strings.Join(w, " ")) != "" {
		return "", false
	}
	for _, a := range w[1:] {
		if unsafeRuleArg(a) {
			return "", false
		}
	}
	prog := w[0]
	if !programRE.MatchString(prog) {
		return "", false
	}
	if slices.Contains(ruleProgramsAlone, prog) {
		return prog, true
	}
	subs, known := ruleSubcommands[prog]
	if !known || len(w) < 2 || !ruleWord.MatchString(w[1]) {
		return "", false
	}
	sub := w[1]
	if slices.Contains(scriptRunners[prog], sub) {
		if len(w) < 3 || !ruleWord.MatchString(w[2]) {
			return "", false
		}
		return prog + " " + sub + " " + w[2], true
	}
	if !slices.Contains(subs, sub) {
		return "", false
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
