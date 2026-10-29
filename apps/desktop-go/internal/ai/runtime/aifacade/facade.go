// Package aifacade：ai-runtime AIClient 的 sessions / tools / memory / asr / tts / avatar 门面
// （ai.chat.* 由 airouter 承担）。32 个契约过程逐字对齐 Node：入参 zod 校验失败 = BAD_INPUT
// "Invalid input"，出参失败 = BAD_OUTPUT，AIClientError = "[CODE|0] msg"，普通 Error = INTERNAL。
package aifacade

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"strconv"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Options：可注入的依赖
type Options struct {
	Now  func() float64 // Date.now()
	Rand func() string  // Math.random().toString(36).slice(2, 8)
	// Tools：ctx.tools（nil = 未注入）
	Tools tools.Registry
	// Profile：ctx.userProfile（nil = 未注入）
	Profile *ProfileStore
	// Avatar：是否装载 AvatarSeamPlugin；AvatarHost = 宿主 cue 发布（nil = 无宿主）
	Avatar     bool
	AvatarHost func(cue *u.Obj)
	// Emit：契约事件（ai.userProfile.changed / ai.avatar.*）
	Emit func(event string, data any)
	// OnConfirm：tools/wrap 确认回执
	OnConfirm func(reqID string, ok bool, reason *string)
}

// Facade 承载内存态（sessions / facts / summaries / tool 开关）
type Facade struct {
	o         Options
	mu        sync.Mutex
	sessions  *u.Obj
	facts     *u.Obj
	summaries *u.Obj
	enabled   map[string]bool
}

func randID() string {
	const al = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 6)
	for i := range b {
		b[i] = al[rand.Intn(36)]
	}
	return string(b)
}

// New 建门面；Profile 变更会发 ai.userProfile.changed
func New(o Options) *Facade {
	if o.Rand == nil {
		o.Rand = randID
	}
	if o.Emit == nil {
		o.Emit = func(string, any) {}
	}
	f := &Facade{o: o, sessions: u.NewObj(), facts: u.NewObj(), summaries: u.NewObj(), enabled: map[string]bool{}}
	if o.Profile != nil {
		o.Profile.OnChanged(func(p any) {
			d := u.NewObj()
			d.Set("profile", p)
			f.o.Emit("ai.userProfile.changed", d)
		})
	}
	return f
}

func aiErr(code, msg string) error {
	return &contract.Error{Code: code, Message: "[" + code + "|0] " + msg}
}

var (
	errBadInput   = &contract.Error{Code: "BAD_INPUT", Message: "Invalid input"}
	errNoProfile  = aiErr("SEAM_NOT_INJECTED", "ctx.userProfile 未注入；请确认已加载 bundle-ig-base")
	errNoASR      = aiErr("SEAM_NOT_INJECTED", "ctx.asr 未注入；请确认 profile 已加载 bundle-ig-electron-caps")
	errNoTTS      = aiErr("SEAM_NOT_INJECTED", "ctx.tts 未注入；请确认 profile 已加载 bundle-ig-electron-caps")
	errNoAvatar   = aiErr("SEAM_NOT_INJECTED", "角色形象仅在装载 bundle-ig-mascot 的 AvatarSeamPlugin 后可用")
	errConfirmReq = aiErr("TOOL_CONFIRM_INVALID", "confirm 必须提供 reqId")
)

type proc struct {
	in  Schema
	out Schema // nil = z.void()
	fn  func(f *Facade, in any) (any, error)
}

var procs = map[string]proc{
	"ai.sessions.list":   {Void, Arr(storedSession), (*Facade).sessionsList},
	"ai.sessions.get":    {idIn, Opt(storedSession), (*Facade).sessionsGet},
	"ai.sessions.create": {Opt(createSessionInput), storedSession, (*Facade).sessionsCreate},
	"ai.sessions.fork":   {sObj("id", str, "overrides", Opt(createSessionInput)), storedSession, (*Facade).sessionsFork},
	"ai.sessions.rename": {sObj("id", str, "title", str), storedSession, (*Facade).sessionsRename},
	"ai.sessions.delete": {idIn, Bool, (*Facade).sessionsDelete},

	"ai.tools.list":       {Void, Arr(toolSpec), (*Facade).toolsList},
	"ai.tools.setEnabled": {sObj("name", str, "enabled", Bool), nil, (*Facade).toolsSetEnabled},
	"ai.tools.confirm":    {sObj("reqId", str, "ok", Bool, "reason", Opt(str)), nil, (*Facade).toolsConfirm},

	"ai.memory.userProfile.get":    {Void, userProfileOut, profileFn(func(p *ProfileStore, _ any) (any, error) { return p.Get(), nil })},
	"ai.memory.userProfile.set":    {profilePatch, userProfileOut, profileFn(func(p *ProfileStore, in any) (any, error) { return p.Set(in.(*u.Obj).Get("patch").(*u.Obj)) })},
	"ai.memory.userProfile.reset":  {Void, userProfileOut, profileFn(func(p *ProfileStore, _ any) (any, error) { return p.Reset() })},
	"ai.memory.userProfile.export": {Void, userProfileOut, profileFn(func(p *ProfileStore, _ any) (any, error) { return p.Export(), nil })},
	"ai.memory.userProfile.import": {sObj("data", Unknown), userProfileOut, profileFn(func(p *ProfileStore, in any) (any, error) { return p.Import(in.(*u.Obj).Get("data")) })},

	"ai.memory.facts.list":    {Void, Arr(storedMemoryFact), (*Facade).factsList},
	"ai.memory.facts.put":     {memoryFact, storedMemoryFact, (*Facade).factsPut},
	"ai.memory.facts.delete":  {idIn, Bool, (*Facade).factsDelete},
	"ai.memory.summaries.get": {sObj("sessionId", str), Opt(sessionSummary), (*Facade).summariesGet},
	"ai.memory.summaries.put": {sessionSummary, sessionSummary, (*Facade).summariesPut},

	"ai.asr.list":       {Void, Unknown, seam(errNoASR)},
	"ai.asr.transcribe": {sObj("pcm", pcmChunk, "opts", Opt(asrOptions)), Unknown, seam(errNoASR)},
	"ai.tts.list":       {Void, Unknown, seam(errNoTTS)},
	"ai.tts.listVoices": {Void, Unknown, seam(errNoTTS)},
	"ai.tts.synth":      {ttsIn, Unknown, seam(errNoTTS)},
	"ai.tts.stream":     {ttsIn, nil, seam(errNoTTS)},
	"ai.tts.stop":       {sObj("reqId", str), nil, seam(errNoTTS)},

	"ai.avatar.isAvailable": {Void, Bool, func(f *Facade, _ any) (any, error) { return f.o.Avatar, nil }},
	"ai.avatar.emotion":     {sObj("name", semanticName, "weight", Opt(numRange(0, 1))), nil, (*Facade).avatarEmotion},
	"ai.avatar.gesture":     {sObj("name", semanticName), nil, avatarCue("gesture", charcontract.SemanticGestures)},
	"ai.avatar.activity":    {sObj("name", semanticName), nil, avatarCue("activity", charcontract.SemanticActivities)},
	"ai.avatar.speaking":    {sObj("level", numRange(0, 1)), nil, (*Facade).avatarSpeaking},
	"ai.avatar.report":      {report, nil, (*Facade).avatarReport},
}

// Names：门面承担的契约过程名
func Names() []string {
	out := make([]string, 0, len(procs))
	for k := range procs {
		out = append(out, k)
	}
	return out
}

func seam(err error) func(*Facade, any) (any, error) {
	return func(*Facade, any) (any, error) { return nil, err }
}

func profileFn(fn func(*ProfileStore, any) (any, error)) func(*Facade, any) (any, error) {
	return func(f *Facade, in any) (any, error) {
		if f.o.Profile == nil {
			return nil, errNoProfile
		}
		return fn(f.o.Profile, in)
	}
}

// Handle 跑一次过程；返回 Undef 表示 undefined
func (f *Facade) Handle(name string, raw json.RawMessage) (any, error) {
	p, ok := procs[name]
	if !ok {
		return nil, &contract.Error{Code: "NOT_FOUND", Message: name}
	}
	in := Undef
	if len(raw) > 0 {
		v, err := u.Parse(raw)
		if err != nil {
			return nil, errBadInput
		}
		in = v
	}
	val, _, ok := Parse(p.in, in)
	if !ok {
		return nil, errBadInput
	}
	out, err := p.fn(f, val)
	if err != nil {
		var ce *contract.Error
		if errors.As(err, &ce) {
			return nil, ce
		}
		return nil, &contract.Error{Code: "INTERNAL", Message: err.Error()}
	}
	if out == nil {
		out = Undef
	}
	sch := p.out
	if sch == nil {
		sch = Void
	}
	res, _, ok := Parse(sch, out)
	if !ok {
		return nil, &contract.Error{Code: "BAD_OUTPUT", Message: "Invalid output of '" + name + "'"}
	}
	return res, nil
}

func wire(v any, err error) (any, error) {
	if err != nil || isUndef(v) {
		return nil, err
	}
	return v, nil
}

// Register 把 32 个过程挂到 Router（ai.tts.stream 是 stream）
func (f *Facade) Register(r *contract.Router) {
	for name := range procs {
		name := name
		if name == "ai.tts.stream" {
			r.Stream(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage, _ func(any) error) (any, error) {
				return wire(f.Handle(name, raw))
			})
			continue
		}
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
			return wire(f.Handle(name, raw))
		})
	}
}

// ---- sessions ----

func optStr(o *u.Obj, k string) (string, bool) {
	if o == nil || !o.Has(k) {
		return "", false
	}
	s, ok := o.Get(k).(string)
	return s, ok
}

func (f *Facade) newSession(title string, preset, meta any) *u.Obj {
	now := f.o.Now()
	s := u.NewObj()
	s.Set("id", "sess_"+strconv.FormatInt(int64(now), 36)+"_"+f.o.Rand())
	s.Set("title", title)
	s.Set("createdAt", now)
	s.Set("updatedAt", now)
	if !isUndef(preset) {
		s.Set("agentPreset", preset)
	}
	if !isUndef(meta) {
		s.Set("meta", meta)
	}
	f.sessions.Set(s.Get("id").(string), s)
	return s
}

func get(o *u.Obj, k string) any {
	if o == nil || !o.Has(k) {
		return Undef
	}
	return o.Get(k)
}

func (f *Facade) sessionsList(any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []any{}
	for _, k := range f.sessions.Keys() {
		out = append(out, deepClone(f.sessions.Get(k)))
	}
	return out, nil
}

func (f *Facade) sessionsGet(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := in.(*u.Obj).Get("id").(string)
	if !f.sessions.Has(id) {
		return Undef, nil
	}
	return deepClone(f.sessions.Get(id)), nil
}

func (f *Facade) sessionsCreate(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, _ := in.(*u.Obj)
	title, ok := optStr(o, "title")
	if !ok {
		title = "New Session"
	}
	return deepClone(f.newSession(title, get(o, "agentPreset"), get(o, "meta"))), nil
}

func (f *Facade) sessionsFork(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := in.(*u.Obj)
	id := o.Get("id").(string)
	if !f.sessions.Has(id) {
		return nil, errors.New("session '" + id + "' not found")
	}
	src := f.sessions.Get(id).(*u.Obj)
	ov, _ := get(o, "overrides").(*u.Obj)
	title, ok := optStr(ov, "title")
	if !ok {
		title = src.Get("title").(string) + " (copy)"
	}
	pick := func(k string) any {
		if v := get(ov, k); !isUndef(v) {
			return v
		}
		return get(src, k)
	}
	return deepClone(f.newSession(title, pick("agentPreset"), pick("meta"))), nil
}

func (f *Facade) sessionsRename(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := in.(*u.Obj)
	id := o.Get("id").(string)
	if !f.sessions.Has(id) {
		return nil, errors.New("session '" + id + "' not found")
	}
	s := f.sessions.Get(id).(*u.Obj)
	s.Set("title", o.Get("title"))
	s.Set("updatedAt", f.o.Now())
	return deepClone(s), nil
}

func (f *Facade) sessionsDelete(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := in.(*u.Obj).Get("id").(string)
	ok := f.sessions.Has(id)
	f.sessions.Delete(id)
	return ok, nil
}

// ---- tools ----

func (f *Facade) toolsList(any) (any, error) {
	out := []any{}
	if f.o.Tools == nil {
		return out, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, t := range f.o.Tools.List() {
		s := u.NewObj()
		s.Set("name", t.Name)
		if !t.NoDescription {
			s.Set("description", t.Description)
		}
		s.Set("parametersJsonSchema", u.NewObj())
		if !t.DangerousUnset {
			s.Set("dangerous", t.Dangerous)
		}
		en, ok := f.enabled[t.Name]
		s.Set("enabled", !ok || en)
		out = append(out, s)
	}
	return out, nil
}

// Enabled：ai.tools.setEnabled 的开关（未设置 = true）
func (f *Facade) Enabled(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	en, ok := f.enabled[name]
	return !ok || en
}

func (f *Facade) toolsSetEnabled(in any) (any, error) {
	o := in.(*u.Obj)
	name := o.Get("name").(string)
	if f.o.Tools == nil {
		return nil, aiErr("TOOL_NOT_FOUND", "tool '"+name+"' 未注册")
	}
	if _, ok := f.o.Tools.Get(name); !ok {
		return nil, aiErr("TOOL_NOT_FOUND", "tool '"+name+"' 未注册")
	}
	f.mu.Lock()
	f.enabled[name] = o.Get("enabled").(bool)
	f.mu.Unlock()
	return Undef, nil
}

func (f *Facade) toolsConfirm(in any) (any, error) {
	o := in.(*u.Obj)
	id := o.Get("reqId").(string)
	if id == "" {
		return nil, errConfirmReq
	}
	if f.o.OnConfirm != nil {
		var reason *string
		if r, ok := optStr(o, "reason"); ok {
			reason = &r
		}
		f.o.OnConfirm(id, o.Get("ok").(bool), reason)
	}
	return Undef, nil
}

// ---- memory ----

func (f *Facade) factsList(any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []any{}
	for _, k := range f.facts.Keys() {
		out = append(out, deepClone(f.facts.Get(k)))
	}
	return out, nil
}

func (f *Facade) factsPut(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := in.(*u.Obj)
	f.facts.Set(o.Get("id").(string), deepClone(o))
	return o, nil
}

func (f *Facade) factsDelete(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := in.(*u.Obj).Get("id").(string)
	ok := f.facts.Has(id)
	f.facts.Delete(id)
	return ok, nil
}

func (f *Facade) summariesGet(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := in.(*u.Obj).Get("sessionId").(string)
	if !f.summaries.Has(id) {
		return Undef, nil
	}
	return deepClone(f.summaries.Get(id)), nil
}

func (f *Facade) summariesPut(in any) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o := in.(*u.Obj)
	f.summaries.Set(o.Get("sessionId").(string), deepClone(o))
	return o, nil
}

// ---- avatar（SemanticAvatarService）----

func inVocab(name string, vocab []string) bool {
	for _, v := range vocab {
		if v == name {
			return true
		}
	}
	return false
}

func (f *Facade) cue(kv ...any) {
	if f.o.AvatarHost == nil {
		return
	}
	c := u.NewObj()
	for j := 0; j+1 < len(kv); j += 2 {
		c.Set(kv[j].(string), kv[j+1])
	}
	f.o.AvatarHost(c)
}

func (f *Facade) avatarEmotion(in any) (any, error) {
	if !f.o.Avatar {
		return nil, errNoAvatar
	}
	o := in.(*u.Obj)
	name := o.Get("name").(string)
	if !inVocab(name, charcontract.SemanticEmotions) {
		return Undef, nil
	}
	if w, ok := o.Get("weight").(float64); ok && o.Has("weight") {
		if w < 0 {
			w = 0
		} else if w > 1 {
			w = 1
		}
		f.cue("type", "emotion", "name", name, "weight", w)
	} else {
		f.cue("type", "emotion", "name", name)
	}
	return Undef, nil
}

func avatarCue(kind string, vocab []string) func(*Facade, any) (any, error) {
	return func(f *Facade, in any) (any, error) {
		if !f.o.Avatar {
			return nil, errNoAvatar
		}
		name := in.(*u.Obj).Get("name").(string)
		if inVocab(name, vocab) {
			f.cue("type", kind, "name", name)
		}
		return Undef, nil
	}
}

func (f *Facade) avatarSpeaking(any) (any, error) {
	if !f.o.Avatar {
		return nil, errNoAvatar
	}
	return Undef, nil
}

func (f *Facade) avatarReport(in any) (any, error) {
	if !f.o.Avatar {
		return nil, errNoAvatar
	}
	o := in.(*u.Obj)
	d := u.NewObj()
	ev := "ai.avatar." + o.Get("type").(string)
	switch o.Get("type") {
	case "touched":
		d.Set("hitbox", o.Get("hitbox"))
	case "clicked":
		d.Set("hitbox", o.Get("hitbox"))
		if b, _ := o.Get("double").(bool); b {
			d.Set("double", true)
		}
	case "scene":
		for _, k := range []string{"characterId", "emotions", "activities", "gestures"} {
			d.Set(k, o.Get(k))
		}
	}
	d.Set("at", f.o.Now())
	f.o.Emit(ev, d)
	return Undef, nil
}
