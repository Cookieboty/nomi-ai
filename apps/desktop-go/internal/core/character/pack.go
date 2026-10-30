// Package character 对应 apps/desktop-electron/internal/core/src/character（packResolve + CharacterPackService.getActive）。
// 校验是 charcontract.ValidatePack（packages/character-contract validatePack 的 1:1 移植，金样见
// charcontract/testdata），覆盖包 lenient、内置包严格，与 Node 相同。
package character

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

var (
	HitboxIDs        = []string{"head", "face", "body", "hand", "hem"}
	OnboardingFiles  = []string{"welcome.webp", "profile.webp", "provider.webp", "privacy.webp"}
	CharacterLocales = []string{"zh", "en"}
	PackModes        = []string{"rive", "sprite", "static"}
	DefaultArtboard  = "Nomi-full"
	DefaultStateMach = "NomiFull"
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
	Downgraded     []string
	// ManifestObj：归一化后的 manifest（JS 形状，= ResolvedPack.manifest），供人设来源读取
	ManifestObj any
}

func exists(root, rel string) bool {
	st, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
	return err == nil && !st.IsDir()
}

// normalizedPack 是 charcontract.ValidatePack 输出（NormalizedPack）里运行时用到的部分。
type normalizedPack struct {
	Manifest manifest `json:"manifest"`
	Mode     string   `json:"mode"`
	Layout   struct {
		Hitboxes     map[string]Region `json:"hitboxes"`
		BubbleAnchor *struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
		} `json:"bubbleAnchor"`
	} `json:"layout"`
	Persona *personaJSON          `json:"persona"`
	Mapping json.RawMessage       `json:"mapping"`
	Locales map[string]LocaleData `json:"locales"`
	Assets  struct {
		Rive           *string `json:"rive"`
		SpriteManifest *string `json:"spriteManifest"`
		Static         *string `json:"static"`
		OnboardingDir  string  `json:"onboardingDir"`
		VoiceDir       string  `json:"voiceDir"`
	} `json:"assets"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// LoadPackAt = packResolve.loadPackAt：用 charcontract（validatePack 的 1:1 移植）校验并归一化；
// 失败时 error 为第一条错误（"file: message"）或 "invalid character pack"。
// Downgraded 为 lenient 放行的问题（供日志）。
func LoadPackAt(root string, lenient bool) (*Pack, error) {
	r := charcontract.LoadPackAt(root, lenient)
	if !r.OK {
		return nil, errors.New(r.Reason)
	}
	var n normalizedPack
	if err := json.Unmarshal([]byte(charcontract.Stringify(r.Pack)), &n); err != nil {
		return nil, fmt.Errorf("invalid character pack: %w", err)
	}
	p := &Pack{
		Root: root, Manifest: n.Manifest, Mode: n.Mode, Persona: n.Persona, Locales: n.Locales,
		Rive: deref(n.Assets.Rive), SpriteManifest: deref(n.Assets.SpriteManifest), Static: deref(n.Assets.Static),
		OnboardingDir: n.Assets.OnboardingDir, VoiceDir: n.Assets.VoiceDir, Downgraded: r.Downgraded,
		ManifestObj: r.Pack.Get("manifest"),
	}
	if string(n.Mapping) != "null" {
		p.Mapping = n.Mapping
	}
	if p.Locales == nil {
		p.Locales = map[string]LocaleData{}
	}
	// hitboxesOf：没有命中区时为 null
	if len(n.Layout.Hitboxes) > 0 {
		p.Hitboxes = &Hitboxes{Regions: n.Layout.Hitboxes, BubbleAnchor: n.Layout.BubbleAnchor}
	}
	return p, nil
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
	// Expressions：包声明的表情（manifest.capabilities.expressions），没有声明时为 null
	Expressions []string `json:"expressions"`
	Reason      string   `json:"reason,omitempty"`
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
	if p.Manifest.Capabilities != nil && p.Manifest.Capabilities.Expressions != nil {
		s.Expressions = p.Manifest.Capabilities.Expressions
	}
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
	builtinCache               *builtinEntry
	listeners                  []func()
}

type builtinEntry struct {
	root string
	pack *Pack
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
	ls := append([]func(){}, s.listeners...)
	s.mu.Unlock()
	for _, fn := range ls {
		fn()
	}
}

// OnChange = CharacterPackService.onChange（Reload 后回调）
func (s *Service) OnChange(fn func()) {
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}

// Resolved = getResolved：当前包（Pack 为 nil 表示没有可用包）
func (s *Service) Resolved() *Pack {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur.Pack
}

// Builtin = getBuiltin：本次构建携带的包（缺失 / 无效时 nil）
func (s *Service) Builtin() *Pack {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur.Source == "builtin" {
		return s.cur.Pack
	}
	if s.built == "" {
		return nil
	}
	if s.builtinCache == nil || s.builtinCache.root != s.built {
		p, err := LoadPackAt(s.built, false)
		if err != nil {
			p = nil
		}
		s.builtinCache = &builtinEntry{root: s.built, pack: p}
	}
	return s.builtinCache.pack
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
