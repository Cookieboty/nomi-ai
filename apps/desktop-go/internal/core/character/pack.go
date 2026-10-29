// Package character 对应 packages/core/src/character（packResolve + CharacterPackService.getActive）。
// 校验只做运行时需要的子集（见 D-B10-2）：manifest 结构、onboarding 四图、rive/static 资源存在。
package character

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

var (
	HitboxIDs          = []string{"head", "face", "body", "hand", "hem"}
	OnboardingFiles    = []string{"welcome.webp", "profile.webp", "provider.webp", "privacy.webp"}
	CharacterLocales   = []string{"zh", "en"}
	PackModes          = []string{"rive", "sprite", "static"}
	DefaultArtboard    = "Nomi-full"
	DefaultStateMach   = "NomiFull"
	legacyMappingEmots = map[string]string{"happy": "nod", "sad": "tears", "surprised": "surprise", "confused": "puzzled", "sleepy": "yawn"}
)

const Scheme = "character-pack"

var winDrive = regexp.MustCompile(`^[a-zA-Z]:`)

// NormalizePackPath = character-contract/paths.normalizePackPath（"" 表示 null）
func NormalizePackPath(in string) string {
	raw := strings.ReplaceAll(strings.TrimSpace(in), `\`, "/")
	if raw == "" || strings.HasPrefix(raw, "/") || winDrive.MatchString(raw) || strings.Contains(raw, "\x00") {
		return ""
	}
	var out []string
	for _, seg := range strings.Split(raw, "/") {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return ""
		}
		out = append(out, seg)
	}
	return strings.Join(out, "/")
}

// normalizeRelPath = packProtocol.normalizePackRelPath（保留结尾 /）
func normalizeRelPath(rel string) string {
	s := strings.ReplaceAll(strings.TrimSpace(rel), `\`, "/")
	if strings.HasPrefix(s, "/") || winDrive.MatchString(s) {
		return ""
	}
	for strings.HasPrefix(s, "./") {
		s = s[2:]
	}
	if s == "" {
		return ""
	}
	var parts []string
	for _, seg := range strings.Split(s, "/") {
		if seg == ".." {
			return ""
		}
		if seg != "" && seg != "." {
			parts = append(parts, seg)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	out := strings.Join(parts, "/")
	if strings.HasSuffix(s, "/") {
		out += "/"
	}
	return out
}

func AssetURL(rel string) string {
	clean := normalizeRelPath(rel)
	if clean == "" {
		clean = strings.ReplaceAll(strings.TrimLeft(rel, "/"), `\`, "/")
	}
	return Scheme + "://pack/" + clean
}

type Region struct {
	Top    float64 `json:"top"`
	Bottom float64 `json:"bottom"`
	Left   float64 `json:"left"`
	Right  float64 `json:"right"`
}

type Hitboxes struct {
	Regions      map[string]Region `json:"regions"`
	BubbleAnchor *struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	} `json:"bubbleAnchor,omitempty"`
}

type manifest struct {
	Schema      any             `json:"schema"`
	ID          string          `json:"id"`
	DisplayName json.RawMessage `json:"displayName"`
	Assets      struct {
		Mode       string `json:"mode"`
		Rive       string `json:"rive"`
		Sprite     string `json:"sprite"`
		Static     string `json:"static"`
		Voice      string `json:"voice"`
		Onboarding string `json:"onboarding"`
		Layout     string `json:"layout"`
	} `json:"assets"`
	Rive *struct {
		Artboard     string `json:"artboard"`
		StateMachine string `json:"stateMachine"`
	} `json:"rive"`
	Layout *struct {
		Hitboxes     map[string]json.RawMessage `json:"hitboxes"`
		BubbleAnchor *struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
		} `json:"bubbleAnchor"`
	} `json:"layout"`
	Capabilities *struct {
		Expressions []string `json:"expressions"`
	} `json:"capabilities"`
}

type personaJSON struct {
	DisplayName string `json:"displayName"`
	ShortName   string `json:"shortName"`
}

type LocaleData struct {
	Lines      map[string]string `json:"lines,omitempty"`
	WakePhrase string            `json:"wakePhrase,omitempty"`
	Persona    *personaJSON      `json:"persona,omitempty"`
}

type Pack struct {
	Root           string
	Manifest       manifest
	Mode           string
	Persona        *personaJSON
	Locales        map[string]LocaleData
	Mapping        json.RawMessage
	Hitboxes       *Hitboxes
	Rive           string
	SpriteManifest string
	Static         string
	OnboardingDir  string
	VoiceDir       string
}

func dirOf(rel, fallback string) string {
	if d := NormalizePackPath(rel); d != "" {
		return d
	}
	return fallback
}

func exists(root, rel string) bool {
	st, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
	return err == nil && !st.IsDir()
}

func readJSON(root, rel string, v any) error {
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("%s: invalid JSON", rel)
	}
	return nil
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// LoadPackAt：校验并归一化一个包目录；失败时返回第一条错误（"file: message"）。
func LoadPackAt(root string, lenient bool) (*Pack, error) {
	p := &Pack{Root: root, Locales: map[string]LocaleData{}}
	if err := readJSON(root, "manifest.json", &p.Manifest); err != nil {
		if os.IsNotExist(err) {
			return nil, errors.New("manifest.json: missing manifest.json")
		}
		return nil, err
	}
	m := &p.Manifest
	if f, ok := m.Schema.(float64); !ok || f != 1 || strings.TrimSpace(m.ID) == "" {
		return nil, errors.New("manifest.json: invalid manifest")
	}
	if m.Assets.Mode == "" {
		m.Assets.Mode = "rive"
	}
	if !contains(PackModes, m.Assets.Mode) {
		return nil, errors.New("manifest.json: invalid assets.mode")
	}
	p.Mode = m.Assets.Mode
	// hitboxes：manifest.layout 优先，其次旧版 layout/hitboxes.json
	var hb map[string]json.RawMessage
	var anchor = (*struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	})(nil)
	if m.Layout != nil {
		hb, anchor = m.Layout.Hitboxes, m.Layout.BubbleAnchor
	}
	if hb == nil {
		var legacy struct {
			Hitboxes     map[string]json.RawMessage `json:"hitboxes"`
			BubbleAnchor *struct {
				X float64 `json:"x"`
				Y float64 `json:"y"`
			} `json:"bubbleAnchor"`
		}
		if readJSON(root, dirOf(m.Assets.Layout, "layout")+"/hitboxes.json", &legacy) == nil {
			hb, anchor = legacy.Hitboxes, legacy.BubbleAnchor
		}
	}
	regions := map[string]Region{}
	for k, raw := range hb {
		var r Region
		if contains(HitboxIDs, k) && json.Unmarshal(raw, &r) == nil {
			regions[k] = r
		} else if !lenient {
			return nil, fmt.Errorf("manifest.json: invalid hitbox %q", k)
		}
	}
	if len(regions) > 0 {
		p.Hitboxes = &Hitboxes{Regions: regions, BubbleAnchor: anchor}
	}

	p.OnboardingDir = dirOf(m.Assets.Onboarding, "onboarding")
	for _, f := range OnboardingFiles {
		rel := p.OnboardingDir + "/" + f
		if !exists(root, rel) {
			return nil, fmt.Errorf("%s: missing %s", rel, rel)
		}
	}
	spriteRel := dirOf(m.Assets.Sprite, "sprite") + "/manifest.json"
	if exists(root, spriteRel) {
		p.SpriteManifest = spriteRel
	}
	if p.Mode == "static" {
		var cands []string
		if d := NormalizePackPath(m.Assets.Static); d != "" {
			if regexp.MustCompile(`(?i)\.(webp|png)$`).MatchString(d) {
				cands = append(cands, d)
			} else {
				cands = append(cands, d+"/character.webp")
			}
		}
		cands = append(cands, "static/character.webp", "static/character.png")
		for _, c := range cands {
			if exists(root, c) {
				p.Static = c
				break
			}
		}
		if p.Static == "" {
			return nil, errors.New("static/character.webp: static mode requires static/character.webp (or .png)")
		}
	} else if p.Mode == "rive" || m.Assets.Rive != "" {
		rel := NormalizePackPath(m.Assets.Rive)
		if m.Assets.Rive == "" || rel == "" {
			rel = "rive/character.riv"
		}
		if !exists(root, rel) {
			return nil, fmt.Errorf("%s: missing %s", rel, rel)
		}
		p.Rive = rel
	}
	p.VoiceDir = dirOf(m.Assets.Voice, "voice")
	for _, lang := range CharacterLocales {
		var ld LocaleData
		if readJSON(root, "locales/"+lang+".json", &ld) == nil {
			p.Locales[lang] = ld
		}
	}
	var per personaJSON
	if readJSON(root, "persona.json", &per) == nil {
		p.Persona = &per
	}
	var mapping struct {
		Emotions map[string]json.RawMessage `json:"emotions"`
	}
	var mraw json.RawMessage
	if readJSON(root, "mapping.json", &mraw) == nil && json.Unmarshal(mraw, &mapping) == nil {
		var expr []string
		if m.Capabilities != nil {
			expr = m.Capabilities.Expressions
		}
		if !isLegacyMapping(mapping.Emotions, expr) {
			p.Mapping = mraw
		}
	}
	return p, nil
}

func isLegacyMapping(emotions map[string]json.RawMessage, expressions []string) bool {
	for k, raw := range emotions {
		legacy, ok := legacyMappingEmots[k]
		if !ok || contains(expressions, legacy) {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) == nil && s == legacy {
			return true
		}
		var arr []string
		if json.Unmarshal(raw, &arr) == nil && contains(arr, legacy) {
			return true
		}
	}
	return false
}

type Names struct {
	ZH string `json:"zh"`
	EN string `json:"en"`
}

type ActiveSnapshot struct {
	Source            string               `json:"source"`
	ID                *string              `json:"id"`
	Mode              *string              `json:"mode"`
	DisplayName       *Names               `json:"displayName"`
	ShortName         *Names               `json:"shortName"`
	AssetBaseURL      *string              `json:"assetBaseUrl"`
	Onboarding        map[string]string    `json:"onboarding"`
	VoiceBaseURL      *string              `json:"voiceBaseUrl"`
	RiveURL           *string              `json:"riveUrl"`
	StaticURL         *string              `json:"staticUrl"`
	SpriteManifestURL *string              `json:"spriteManifestUrl"`
	Hitboxes          *Hitboxes            `json:"hitboxes"`
	Rive              *RiveInfo            `json:"rive"`
	Locales           map[string]LocaleOut `json:"locales"`
	Mapping           json.RawMessage      `json:"mapping"`
	Reason            string               `json:"reason,omitempty"`
}

type RiveInfo struct {
	Artboard     string `json:"artboard"`
	StateMachine string `json:"stateMachine"`
}

type LocaleOut struct {
	Lines      map[string]string `json:"lines,omitempty"`
	WakePhrase string            `json:"wakePhrase,omitempty"`
}

func personaNames(dn, sn string, ovDN, ovSN string) (string, string) {
	displayName := dn
	if ovDN != "" {
		displayName = ovDN
	}
	shortName := ovSN
	if shortName == "" && ovDN == "" {
		shortName = sn
	}
	if shortName == "" {
		shortName = displayName
	}
	return displayName, shortName
}

func namesOf(p *Pack) (Names, Names) {
	m := p.Manifest
	var legacyZH, legacyEN string
	var s string
	if json.Unmarshal(m.DisplayName, &s) == nil {
		legacyZH = s
	} else {
		var o struct{ ZH, EN string }
		if json.Unmarshal(m.DisplayName, &o) == nil {
			legacyZH, legacyEN = o.ZH, o.EN
		}
	}
	dn := m.ID
	var sn string
	if p.Persona != nil && p.Persona.DisplayName != "" {
		dn = p.Persona.DisplayName
	} else if legacyZH != "" {
		dn = legacyZH
	}
	if p.Persona != nil {
		sn = p.Persona.ShortName
	}
	zhD, zhS := personaNames(dn, sn, "", "")
	enD, enS := zhD, zhS
	if en, ok := p.Locales["en"]; ok && en.Persona != nil && (en.Persona.DisplayName != "" || en.Persona.ShortName != "") {
		enD, enS = personaNames(zhD, zhS, en.Persona.DisplayName, en.Persona.ShortName)
	} else if legacyEN != "" {
		enD, enS = legacyEN, legacyEN
	}
	return Names{zhD, enD}, Names{zhS, enS}
}

func linesOf(p *Pack) map[string]LocaleOut {
	out := map[string]LocaleOut{}
	for lang, d := range p.Locales {
		e := LocaleOut{Lines: d.Lines, WakePhrase: d.WakePhrase}
		if e.Lines != nil || e.WakePhrase != "" {
			out[lang] = e
		}
	}
	return out
}

type Resolved struct {
	Source string
	Pack   *Pack
	Reason string
}

// Resolve = packResolve.resolveCharacterPack：userData → resources → 内置
func Resolve(userDataPack, resourcesPack, builtinPack string) Resolved {
	skipped := false
	for _, c := range []struct{ src, root string }{{"userData", userDataPack}, {"resources", resourcesPack}} {
		if c.root == "" || !exists(c.root, "manifest.json") {
			continue
		}
		p, err := LoadPackAt(c.root, true)
		if err != nil {
			skipped = true
			continue
		}
		return Resolved{Source: c.src, Pack: p}
	}
	reason := "no overlay present"
	if skipped {
		reason = "overlay invalid — using built-in"
	}
	if builtinPack != "" {
		if p, err := LoadPackAt(builtinPack, false); err == nil {
			return Resolved{Source: "builtin", Pack: p, Reason: reason}
		}
		return Resolved{Source: "builtin", Reason: "built-in pack invalid"}
	}
	return Resolved{Source: "builtin", Reason: reason}
}

func sp(s string) *string { return &s }
func spn(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Snapshot = CharacterPackService.getActive
func (r Resolved) Snapshot() ActiveSnapshot {
	empty := ActiveSnapshot{Source: "builtin", Reason: r.Reason}
	if r.Pack == nil {
		return empty
	}
	p := r.Pack
	dn, sn := namesOf(p)
	s := empty
	s.ID, s.Mode, s.DisplayName, s.ShortName = sp(p.Manifest.ID), sp(p.Mode), &dn, &sn
	s.Hitboxes, s.Locales, s.Mapping = p.Hitboxes, linesOf(p), p.Mapping
	if r.Source == "builtin" {
		return s
	}
	s.Source, s.Reason = r.Source, ""
	s.AssetBaseURL = sp(AssetURL(""))
	od := p.OnboardingDir + "/"
	s.Onboarding = map[string]string{}
	for _, k := range []string{"welcome", "profile", "provider", "privacy"} {
		s.Onboarding[k] = AssetURL(od + k + ".webp")
	}
	s.VoiceBaseURL = sp(AssetURL(p.VoiceDir + "/zh/"))
	if p.Mode == "rive" && p.Rive != "" {
		s.RiveURL = sp(AssetURL(p.Rive))
	}
	if p.Mode == "static" && p.Static != "" {
		s.StaticURL = sp(AssetURL(p.Static))
	}
	if p.SpriteManifest != "" {
		s.SpriteManifestURL = sp(AssetURL(p.SpriteManifest))
	}
	if p.Mode == "rive" {
		ri := RiveInfo{DefaultArtboard, DefaultStateMach}
		if p.Manifest.Rive != nil {
			if p.Manifest.Rive.Artboard != "" {
				ri.Artboard = p.Manifest.Rive.Artboard
			}
			if p.Manifest.Rive.StateMachine != "" {
				ri.StateMachine = p.Manifest.Rive.StateMachine
			}
		}
		s.Rive = &ri
	}
	return s
}

// Service 持有当前解析结果
type Service struct {
	mu                         sync.Mutex
	userData, resources, built string
	cur                        Resolved
}

func NewService(userData, resources, builtin string) *Service {
	s := &Service{userData: userData, resources: resources, built: builtin}
	s.Reload()
	return s
}

func (s *Service) Reload() {
	res := ""
	if s.resources != "" {
		res = filepath.Join(s.resources, "character-pack")
	}
	r := Resolve(filepath.Join(s.userData, "character-pack"), res, s.built)
	s.mu.Lock()
	s.cur = r
	s.mu.Unlock()
}

func (s *Service) Active() ActiveSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur.Snapshot()
}

func (s *Service) Root() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur.Pack == nil {
		return ""
	}
	return s.cur.Pack.Root
}
