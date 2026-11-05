package desktop

// command_review.go：Nomi 要跑的命令（workspace_run）先交给辅助模型
// 判一次风险，低风险直接放行，拿不准 / 高风险的交给人确认（卡片带风险等级与理由）。
// 风险分级与授权打分参考 Codex guardian；Nomi 不替用户拒绝，结论只有「放行」与「交给人」。

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/prompts"
)

type RiskLevel = string
type UserAuthorization = string

type CommandReview struct {
	Risk          RiskLevel
	Authorization UserAuthorization
	// Outcome：allow = 自动放行；ask = 交给人确认
	Outcome   string
	Rationale string
}

type CommandReviewInput struct {
	Tool     string
	Command  string
	Cwd      string
	UserText string
	Tainted  bool
}

// ConfirmReview：确认卡片上的审核结果（风险等级 + 理由）
type ConfirmReview struct {
	Risk      string `json:"risk"`
	Rationale string `json:"rationale,omitempty"`
}

// ReviewedTools：交给辅助模型审核的工具（跑任意命令的）；code_run 在沙箱里跑，不审
var ReviewedTools = map[string]bool{"workspace_run": true}

var riskLevels = []string{"low", "medium", "high", "critical"}
var userAuths = []string{"unknown", "low", "medium", "high"}

// OutcomeFor：风险 × 是否读过外部内容 → 放行 / 交给人
func OutcomeFor(risk RiskLevel, tainted bool) string {
	switch risk {
	case "low":
		return "allow"
	case "medium":
		if tainted {
			return "ask"
		}
		return "allow"
	}
	return "ask"
}

// ReviewSystemPrompt：prompts/text/command-review.md
var ReviewSystemPrompt = prompts.Text("command-review")

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// ReviewCommandMax = REVIEW_COMMAND_MAX：审核看完整命令不截断，超过上限的不审、交给人（#222）
const ReviewCommandMax = 8000

// ReviewMessages = reviewMessages
func ReviewMessages(i CommandReviewInput) []map[string]string {
	user := clipRunes(strings.TrimSpace(i.UserText), 2000)
	if user == "" {
		user = "(none)"
	}
	cwd := i.Cwd
	if cwd == "" {
		cwd = "(unknown)"
	}
	tainted := "no"
	if i.Tainted {
		tainted = "yes"
	}
	return []map[string]string{
		{"role": "system", "content": ReviewSystemPrompt},
		{"role": "user", "content": prompts.Render("command-review-user", map[string]any{
			"UserText": user, "Cwd": cwd, "Tainted": tainted, "Command": i.Command})},
	}
}

// jsonObjects：回复里每个花括号配平的 {…} 片段（跳过字符串里的括号），按出现顺序；回复过长只看前 16K
func jsonObjects(text string) []string {
	if len(text) > 16000 {
		text = text[:16000]
	}
	var out []string
	for start := strings.IndexByte(text, '{'); start >= 0; {
		depth, inStr, esc, end := 0, false, false, -1
		for i := start; i < len(text) && end < 0; i++ {
			c := text[i]
			switch {
			case inStr && esc:
				esc = false
			case inStr && c == '\\':
				esc = true
			case inStr && c == '"':
				inStr = false
			case inStr:
			case c == '"':
				inStr = true
			case c == '{':
				depth++
			case c == '}':
				if depth--; depth == 0 {
					end = i
				}
			}
		}
		if end >= 0 {
			out = append(out, text[start:end+1])
		}
		next := strings.IndexByte(text[start+1:], '{')
		if next < 0 {
			break
		}
		start += 1 + next
	}
	return out
}

// ParseReview = parseReview：取回复里的审核 JSON（允许包在代码块里、前后有说明文字）；不合法返回 nil。
// 逐个尝试配平的 {…}（不用贪婪正则：说明里带花括号或输出多段 JSON 时不至于整体解析失败）；
// 有多段合法结论时取风险最高的一段（宁严勿松）。
func ParseReview(text string, tainted bool) *CommandReview {
	var best map[string]any
	bestRank := -1
	for _, frag := range jsonObjects(text) {
		var j map[string]any
		if json.Unmarshal([]byte(frag), &j) != nil {
			continue
		}
		risk, _ := j["risk_level"].(string)
		if r := slices.Index(riskLevels, risk); r > bestRank {
			best, bestRank = j, r
		}
	}
	if best == nil {
		return nil
	}
	risk := riskLevels[bestRank]
	auth, _ := best["user_authorization"].(string)
	if !slices.Contains(userAuths, auth) {
		auth = "unknown"
	}
	why, _ := best["rationale"].(string)
	return &CommandReview{Risk: risk, Authorization: auth, Outcome: OutcomeFor(risk, tainted),
		Rationale: clipRunes(strings.TrimSpace(why), 300)}
}

// ReviewTimeout：辅助模型要快，等太久不如直接问人
const ReviewTimeout = 15 * time.Second

// ReviewCommand = reviewCommand：complete 是辅助模型补全；出错 / 超时 / 回复不合法 / 命令超长返回 nil（交给人）
func ReviewCommand(ctx context.Context, i CommandReviewInput,
	complete func(ctx context.Context, messages []map[string]string) (string, error), timeout time.Duration) *CommandReview {
	if utf8.RuneCountInString(i.Command) > ReviewCommandMax {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if timeout <= 0 {
		timeout = ReviewTimeout
	}
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type res struct {
		text string
		err  error
	}
	ch := make(chan res, 1)
	go func() {
		t, err := complete(c, ReviewMessages(i))
		ch <- res{t, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			return nil
		}
		return ParseReview(r.text, i.Tainted)
	case <-c.Done():
		return nil
	}
}
