// Package persona = packages/core/src/persona（PersonaService / systemPrompt）：角色人设的唯一来源。
// 来源依次为当前角色包 → 内置角色包 → 中性兜底；按界面语言取文案（zh 为主语言，其他语言用 locales/<lang>.json 覆盖）。
package persona

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	cc "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
)

// Persona = @nomi-ai/types Persona；字段顺序与 Node 对象构造顺序一致（JSON.stringify 比较 / 输出）
type Persona struct {
	CharacterID          string   `json:"characterId"`
	DisplayName          string   `json:"displayName"`
	ShortName            string   `json:"shortName"`
	SystemPromptIdentity string   `json:"systemPromptIdentity"`
	Greetings            []string `json:"greetings"`
	Pronoun              string   `json:"pronoun"`
	AddressUser          string   `json:"addressUser,omitempty"`
}

func (p Persona) clone() Persona {
	p.Greetings = append([]string{}, p.Greetings...)
	return p
}

// Bundle = PersonaBundle：主语言人设 + 其他语言覆盖（均为 personaSchema 解析后的 JS 形状）
type Bundle struct {
	CharacterID string
	Persona     *cc.Obj
	Locales     map[string]*cc.Obj
}

// Source = PersonaSource：Load 返回 nil 表示交给下一个来源；error = 来源抛错
type Source struct {
	ID   string
	Load func() (*Bundle, error)
}

// CharacterLocaleOf = characterLocaleOf：zh* → zh，其余非空 → en，空 → zh
func CharacterLocaleOf(ui string) string {
	first := ""
	if l := strings.ToLower(ui); l != "" {
		i := strings.IndexAny(l, "-_")
		if i < 0 {
			first = l
		} else {
			first = l[:i]
		}
	}
	for _, l := range cc.CharacterLocales {
		if l == first {
			return l
		}
	}
	if first != "" {
		return "en"
	}
	return cc.PrimaryLocale
}

func str(o *cc.Obj, k string) (string, bool) {
	if o == nil {
		return "", false
	}
	s, ok := o.Get(k).(string)
	return s, ok
}

func strs(o *cc.Obj, k string) ([]string, bool) {
	if o == nil {
		return nil, false
	}
	a, ok := o.Get(k).([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(a))
	for _, v := range a {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out, true
}

// Resolve = resolvePersona
func Resolve(b *Bundle, ui string) Persona {
	lang := CharacterLocaleOf(ui)
	var ov *cc.Obj
	if lang != cc.PrimaryLocale {
		ov = b.Locales[lang]
	}
	base := b.Persona
	bdn, _ := str(base, "displayName")
	bsn, _ := str(base, "shortName")
	dn, sn := cc.PersonaNames(bdn, bsn, ov)
	p := Persona{CharacterID: b.CharacterID, DisplayName: dn, ShortName: sn}
	if v, ok := str(ov, "systemPromptIdentity"); ok {
		p.SystemPromptIdentity = v
	} else {
		p.SystemPromptIdentity, _ = str(base, "systemPromptIdentity")
	}
	if g, ok := strs(ov, "greetings"); ok {
		p.Greetings = g
	} else if g, ok := strs(base, "greetings"); ok {
		p.Greetings = g
	} else {
		p.Greetings = []string{}
	}
	var own string
	if lang == cc.PrimaryLocale {
		own, _ = str(base, "pronoun")
	} else {
		own, _ = str(ov, "pronoun")
	}
	p.Pronoun = cc.PersonaPronoun(lang, own)
	if v, ok := str(ov, "addressUser"); ok {
		p.AddressUser = v
	} else {
		p.AddressUser, _ = str(base, "addressUser")
	}
	return p
}

// NeutralSource = neutralPersonaSource
func NeutralSource() Source {
	po := cc.NewObj()
	po.Set("displayName", "AI")
	po.Set("systemPromptIdentity", "You are an AI companion living on the user desktop.")
	po.Set("greetings", []any{})
	b := &Bundle{CharacterID: "none", Persona: po, Locales: map[string]*cc.Obj{}}
	return Source{ID: "neutral", Load: func() (*Bundle, error) { return b, nil }}
}

// ActivePack = { root, manifest }（manifest 为归一化后的 JS 形状）
type ActivePack struct {
	Root     string
	Manifest any
}

// ReadFile = fs.existsSync ? readFileSync(utf8) : undefined；目录等读失败返回 error（Node 抛错）
func ReadFile(file string) (string, bool, error) {
	if _, err := os.Stat(file); err != nil {
		return "", false, nil
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return "", false, err
	}
	return cc.DecodeUTF8(b), true, nil
}

type jsThrow struct{ err error }

// PackSource = packPersonaSource
func PackSource(id string, getPack func() *ActivePack, readFile func(string) (string, bool, error)) Source {
	if readFile == nil {
		readFile = ReadFile
	}
	if id == "" {
		id = "character-pack"
	}
	return Source{ID: id, Load: func() (b *Bundle, err error) {
		defer func() {
			if r := recover(); r != nil {
				if t, ok := r.(jsThrow); ok {
					b, err = nil, t.err
					return
				}
				// getPack 抛出（例如 validatePack 的 TypeError）：Node 的 source.load 在 try/catch 里
				if e, ok := r.(error); ok {
					b, err = nil, e
					return
				}
				panic(r)
			}
		}()
		pack := getPack()
		if pack == nil || pack.Root == "" {
			return nil, nil
		}
		manifest, ok := pack.Manifest.(*cc.Obj)
		if !ok {
			return nil, nil
		}
		characterID, _ := manifest.Get("id").(string)
		if characterID == "" {
			return nil, nil
		}
		root := pack.Root
		text := func(rel string) *string {
			norm, ok := cc.NormalizePackPath(rel)
			if !ok || norm == "" {
				return nil
			}
			t, ok, err := readFile(filepath.Join(append([]string{root}, strings.Split(norm, "/")...)...))
			if err != nil {
				panic(jsThrow{err})
			}
			if !ok {
				return nil
			}
			return &t
		}
		jsonOf := func(rel string) any {
			t := text(rel)
			if t == nil {
				return cc.Undef
			}
			v, err := cc.ParseJSON(*t)
			if err != nil {
				log.Printf("[persona] WARN character pack %s is not valid JSON: %v", rel, err)
				return cc.Undef
			}
			return v
		}
		copyDir := cc.DirLegacyCopy
		if assets, ok := manifest.Get("assets").(*cc.Obj); ok {
			if c, ok := assets.Get("copy").(string); ok {
				if n, ok := cc.NormalizePackPath(c); ok && n != "" {
					copyDir = n
				}
			}
		}
		var po *cc.Obj
		if raw := jsonOf(cc.FilePersona); raw != cc.Undef {
			if o, ok := cc.ParsePersona(raw); ok {
				po = o
			} else {
				log.Printf("[persona] WARN character pack persona.json is invalid")
			}
		}
		if po == nil {
			po = cc.MigrateLegacyPersona(manifest, jsonOf(copyDir+"/"+cc.PrimaryLocale+".json"), text(cc.FileLegacySysPrompt), cc.PrimaryLocale)
		}
		if po == nil {
			return nil, nil
		}
		locales := map[string]*cc.Obj{}
		for _, lang := range cc.CharacterLocales {
			if lang == cc.PrimaryLocale {
				continue
			}
			raw := jsonOf(cc.DirLocales + "/" + lang + ".json")
			if raw == cc.Undef {
				legacy := jsonOf(copyDir + "/" + lang + ".json")
				if legacy != cc.Undef {
					if m := cc.MigrateLegacyCopy(legacy); m != nil {
						raw = m
					}
				}
			}
			if raw == cc.Undef {
				continue
			}
			if res, ok := cc.ParseCharacterLocale(raw); ok {
				if p, ok := res.Get("persona").(*cc.Obj); ok {
					locales[lang] = p
				}
			}
		}
		return &Bundle{CharacterID: characterID, Persona: po, Locales: locales}, nil
	}}
}

func same(a, b Persona) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// Service = PersonaService
type Service struct {
	mu        sync.Mutex
	sources   []Source
	locale    func() string
	bundle    *Bundle
	current   Persona
	listeners []func(Persona)
}

func New(sources []Source, locale func() string) (*Service, error) {
	if len(sources) == 0 {
		return nil, errors.New("PersonaService needs at least one source")
	}
	s := &Service{sources: sources, locale: locale}
	b, err := s.load()
	if err != nil {
		return nil, err
	}
	s.bundle = b
	s.current = Resolve(b, locale())
	return s, nil
}

func (s *Service) Get() Persona {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current.clone()
}

func (s *Service) OnChange(fn func(Persona)) {
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}

// Reload：重新读取来源；人设有变化才通知
func (s *Service) Reload() Persona {
	b, err := s.load()
	if err != nil {
		log.Printf("[persona] WARN %v", err)
		return s.Get()
	}
	s.mu.Lock()
	s.bundle = b
	s.mu.Unlock()
	return s.update()
}

// LocaleChanged：界面语言变化后调用
func (s *Service) LocaleChanged() Persona { return s.update() }

func (s *Service) update() Persona {
	s.mu.Lock()
	next := Resolve(s.bundle, s.locale())
	changed := !same(next, s.current)
	if changed {
		s.current = next
	}
	snap := s.current.clone()
	ls := append([]func(Persona){}, s.listeners...)
	s.mu.Unlock()
	if changed {
		for _, fn := range ls {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[persona] WARN persona listener failed: %v", r)
					}
				}()
				fn(snap.clone())
			}()
		}
	}
	return snap
}

func (s *Service) load() (*Bundle, error) {
	for _, src := range s.sources {
		b, err := src.Load()
		if err != nil {
			log.Printf("[persona] WARN persona source %q failed: %v", src.ID, err)
			continue
		}
		if b != nil {
			return b, nil
		}
	}
	return nil, fmt.Errorf("no persona source produced a persona")
}

// ChatGuidanceKey = CHAT_GUIDANCE_KEY
const ChatGuidanceKey = "ui.chat-settings.you-run-on-the-user-s-own-computer-be"

// DefaultSystemPrompt = defaultSystemPrompt：身份段 + 对话要求（各自 trim，空的略过）
func DefaultSystemPrompt(p *Persona, translate func(string) string) string {
	parts := []string{}
	cands := []string{}
	if p != nil {
		cands = append(cands, p.SystemPromptIdentity)
	}
	cands = append(cands, translate(ChatGuidanceKey))
	for _, c := range cands {
		if t := jsTrim(c); t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, "\n")
}

// jsTrim = String.prototype.trim（WhiteSpace + LineTerminator）
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
			return true
		}
		return r >= 0x2000 && r <= 0x200A
	})
}
