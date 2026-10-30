// Package models mirrors apps/desktop-electron/internal/gateway/src/models/{types,families,catalog,
// effective,buildCatalog}.ts and models.ts. Spec data is kept as ordered
// objects (*util.Obj) so merges and serialisation follow the JS key order.
package models

import (
	"regexp"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const familiesJSON = `[
  {"family":"claude","match":["claude-*","claude*"],"wires":{"prefer":["messages"],"reason":"保住签名、缓存与思考控制"},"reasoning":{"control":"budget","canDisable":true},"params":{"requireMaxTokens":true}},
  {"family":"gpt","match":["gpt-5*","gpt-6*","o1*","o3*","o4*","codex*","gpt-*-codex*"],"wires":{"prefer":["responses"],"reason":"保住加密推理"},"reasoning":{"control":"effort","efforts":["minimal","low","medium","high"]},"params":{"maxTokensField":"max_completion_tokens"},"sampling":{"temperature":false,"topP":false}},
  {"family":"gemini","match":["gemini-*"],"wires":{"prefer":["gemini"],"reason":"思考签名与 thinkingConfig 只在原生协议上完整"},"tools":{"schema":"gemini"}},
  {"family":"deepseek","match":["deepseek-*"],"reasoning":{"control":"toggle","canDisable":true,"passback":"required","passbackField":"reasoning_content"},"tools":{"schema":"deepseek"}},
  {"family":"kimi","match":["kimi-*","moonshot-*"],"reasoning":{"control":"toggle","passback":"required","passbackField":"reasoning_content"},"tools":{"schema":"kimi"}},
  {"family":"glm","match":["glm-*"],"reasoning":{"control":"toggle","passback":"required","passbackField":"reasoning_content"}},
  {"family":"qwen","match":["qwen*"],"reasoning":{"control":"toggle","canDisable":true,"toggleStyle":"enable-thinking"}},
  {"family":"minimax","match":["minimax-*"],"reasoning":{"control":"none","passback":"required","passbackField":"reasoning_details"}},
  {"family":"grok","match":["grok-*"],"wires":{"prefer":["responses"],"reason":"xAI 的 Chat 接口标为 legacy"}}
]`

// Families is FAMILIES.
var Families []*u.Obj

type compiledFamily struct {
	f   *u.Obj
	res []*regexp.Regexp
}

var compiled []compiledFamily

// GlobRe is globRe (only * is special; case-insensitive, anchored).
func GlobRe(glob string) *regexp.Regexp {
	esc := strings.ReplaceAll(regexp.QuoteMeta(glob), `\*`, `.*`)
	return regexp.MustCompile(`(?i)^(?:` + esc + `)$`)
}

func init() {
	v, err := u.ParseString(familiesJSON)
	if err != nil {
		panic(err)
	}
	for _, f := range v.([]any) {
		o := f.(*u.Obj)
		Families = append(Families, o)
		c := compiledFamily{f: o}
		for _, g := range o.Get("match").([]any) {
			c.res = append(c.res, GlobRe(g.(string)))
		}
		compiled = append(compiled, c)
	}
}

// FamilyOf is familyOf (nil = none).
func FamilyOf(bareID string) *u.Obj {
	for _, c := range compiled {
		for _, r := range c.res {
			if r.MatchString(bareID) {
				return c.f
			}
		}
	}
	return nil
}
