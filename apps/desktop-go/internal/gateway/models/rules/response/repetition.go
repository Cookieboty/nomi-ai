package response

import (
	"regexp"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// RepeatWindow / RepeatDistinct are REPEAT_WINDOW / REPEAT_DISTINCT.
const (
	RepeatWindow   = 40
	RepeatDistinct = 3
	minSentence    = 5
)

// RepetitionMessage is REPETITION_MESSAGE.
const RepetitionMessage = "Nomi 网关：模型陷入重复输出，已中断这一轮"

var sentenceRe = regexp.MustCompile(`[.!?。！？\n]+`)

type channel struct {
	partial string
	recent  []string
	n, k    int
}

func (c *channel) push(text string) bool {
	c.partial += text
	last := 0
	hit := false
	for _, m := range sentenceRe.FindAllStringIndex(c.partial, -1) {
		if m[1] == len(c.partial) {
			break
		}
		if c.add(c.partial[last:m[0]]) {
			hit = true
		}
		last = m[1]
	}
	c.partial = c.partial[last:]
	if u.UTF16Len(c.partial) > 4000 {
		c.partial = u.UTF16Tail(c.partial, 2000)
	}
	return hit
}

func (c *channel) add(sentence string) bool {
	s := u.JSTrim(sentence)
	if u.UTF16Len(s) < minSentence {
		return false
	}
	c.recent = append(c.recent, s)
	if len(c.recent) > c.n {
		c.recent = c.recent[1:]
	}
	if len(c.recent) < c.n {
		return false
	}
	set := map[string]bool{}
	for _, r := range c.recent {
		set[r] = true
	}
	return len(set) <= c.k
}

// RepetitionGuard is RepetitionGuard.
type RepetitionGuard struct {
	think, text *channel
	Tripped     bool
}

// NewRepetitionGuard uses the default window.
func NewRepetitionGuard() *RepetitionGuard {
	return &RepetitionGuard{think: &channel{n: RepeatWindow, k: RepeatDistinct}, text: &channel{n: RepeatWindow, k: RepeatDistinct}}
}

// Push returns true when repetition tripped.
func (g *RepetitionGuard) Push(kind, s string) bool {
	if g.Tripped || s == "" {
		return g.Tripped
	}
	ch := g.text
	if kind == "think" {
		ch = g.think
	}
	if ch.push(s) {
		g.Tripped = true
	}
	return g.Tripped
}
