package cli

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// GitCommitContext = gitOps.GitCommitContext。
type GitCommitContext struct {
	Subjects  []string
	Stat      string
	Diff      string
	Truncated bool
}

type CommitMessageMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// CommitMessagePrompt = commitMessagePrompt。
func CommitMessagePrompt(ctx GitCommitContext) []CommitMessageMsg {
	subj := "(none)"
	if len(ctx.Subjects) > 0 {
		ls := make([]string, len(ctx.Subjects))
		for i, s := range ctx.Subjects {
			ls[i] = "- " + s
		}
		subj = strings.Join(ls, "\n")
	}
	stat := ctx.Stat
	if stat == "" {
		stat = "(none)"
	}
	tr := ""
	if ctx.Truncated {
		tr = " (truncated)"
	}
	return []CommitMessageMsg{
		{Role: "system", Content: "You write git commit messages. Reply with the commit message only: no code fences, no quotes, no commentary."},
		{Role: "user", Content: strings.Join([]string{
			"Write a commit message for the change below.",
			"- Match the style of the repository's recent commits: their language, whether they use Conventional Commits and which scopes, and their length.",
			"- Keep every line under 100 characters. Subject first; add a short body after a blank line only if the change needs explaining.",
			"- Describe what changed and why, not the file list.",
			"",
			"Recent commits:",
			subj,
			"",
			"Files:",
			stat,
			"",
			"Diff" + tr + ":",
			ctx.Diff,
		}, "\n")},
	}
}

// 显式大小写类，避免 RE2 (?i) 把 ſ / K(U+212A) 折叠成 ASCII（JS 非 u 模式的 /i 不折叠）
func ciLit(s string) string {
	var b strings.Builder
	for _, r := range s {
		lo, up := strings.ToLower(string(r)), strings.ToUpper(string(r))
		if lo != up {
			b.WriteString("[" + lo + up + "]")
		} else {
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	return b.String()
}

var (
	cmCRLF   = regexp.MustCompile(`\r\n?`)
	cmThink  = regexp.MustCompile(ciLit("<think>") + `(?s:.*?)` + ciLit("</think>"))
	cmFence  = regexp.MustCompile("^```[\\w-]*\\n((?s:.*?))\\n```$")
	cmPrefix = regexp.MustCompile(`^(` + ciLit("commit message") + `|提交信息)` + util.JSWhitespace + `*[:：]` + util.JSWhitespace + `*`)
	cmQuotes = regexp.MustCompile("^[\"'`]+|[\"'`]+$")
	cmBlank  = regexp.MustCompile(`\n{3,}`)
)

// CleanCommitMessage = cleanCommitMessage。
func CleanCommitMessage(raw string) string {
	s := util.JSTrim(cmCRLF.ReplaceAllString(raw, "\n"))
	s = util.JSTrim(cmThink.ReplaceAllString(s, ""))
	// JS 的 $ 无 m 标志 = 串尾；Go 的 $ 同样（非 (?m)）
	if m := cmFence.FindStringSubmatch(s); m != nil {
		s = util.JSTrim(m[1])
	}
	s = cmPrefix.ReplaceAllString(s, "")
	s = util.JSTrim(cmQuotes.ReplaceAllString(s, ""))
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = util.JSTrimEnd(l)
	}
	s = cmBlank.ReplaceAllString(strings.Join(lines, "\n"), "\n\n")
	return util.JSTrim(clisdk.Slice0(s, 4000))
}
