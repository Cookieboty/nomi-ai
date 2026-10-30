package voice

import (
	"context"
	"encoding/binary"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// VolcASRHost = VOLC_ASR_HOST
const VolcASRHost = "openspeech.bytedance.com"

const maxWavBytes = 25 * 1024 * 1024

// Provider / Credentials = VoiceDeps.providers / credentials 的元素
type Provider struct{ ID, Name, BaseURL string }
type Credentials struct{ ID, Name, BaseURL, APIKey string }

// AuditEvent = VoiceDeps.audit 的参数（args 键序同 Node 字面量）
type AuditEvent struct {
	Tool     string
	Args     *util.Obj
	Decision string
	Result   string
	Ms       *int64
	Provider string
}

// Deps = VoiceDeps
type Deps struct {
	Root        string
	Secrets     security.SecretBox
	Providers   func() []Provider
	Credentials func(id string) *Credentials
	LocalOnly   func() bool
	Audit       func(AuditEvent)
	// OpenChat 打开对话窗口；页面仍在加载时返回 once('did-finish-load') 的登记函数，否则 nil
	OpenChat          func() (onceLoaded func(fn func()))
	Publish           func(name string, payload any)
	PublishChat       func(name string, payload any)
	SendToMascot      func(cmd *util.Obj)
	DefaultWakePhrase func() string
	IsLocalURL        func(u string) bool
	T                 func(key string, args ...any) string
	Logf              func(format string, args ...any)
	Now               func() time.Time
	Fetch             FetchLike
	Platform          string // `${process.platform}-${process.arch}`；空 = PlatformKey()
	Env               func() map[string]string
	Transcribe        func(ctx context.Context, o CloudOpts) (string, error) // 测试注入
	Whisper           func(ctx context.Context, o WhisperOpts) (string, error)
	VolcURL           string         // 测试注入（Node volcUrl）
	VolcTimeouts      VolcTimeouts   // 测试注入（Node volcTimeouts）
	VolcPace          *time.Duration // 测试注入（Node volcPaceMs）
}

// Error = VoiceError
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

type dl struct {
	cancel   context.CancelFunc
	ctx      context.Context
	received float64
	total    float64
}

// Service = VoiceService
type Service struct {
	d         Deps
	mu        sync.Mutex
	settings  Settings
	downloads map[string]*dl
	activity  string

	streams      []streamEntry
	streamOwners map[int]bool
	streamSeq    int
	toCancel     []*VolcSession
}

func NewService(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.T == nil {
		d.T = func(k string, _ ...any) string { return k }
	}
	if d.Logf == nil {
		d.Logf = func(string, ...any) {}
	}
	if d.Publish == nil {
		d.Publish = func(string, any) {}
	}
	if d.Platform == "" {
		d.Platform = PlatformKey()
	}
	if d.Transcribe == nil {
		d.Transcribe = TranscribeOpenAICompat
	}
	if d.Whisper == nil {
		d.Whisper = RunWhisperCli
	}
	s := &Service{d: d, downloads: map[string]*dl{}, activity: "idle", streamOwners: map[int]bool{}}
	s.settings = s.load()
	return s
}

func (s *Service) nowMs() int64         { return s.d.Now().UnixMilli() }
func (s *Service) settingsFile() string { return filepath.Join(s.d.Root, "settings.json") }
func (s *Service) modelsDir() string    { return filepath.Join(s.d.Root, "models") }
func (s *Service) volcKeyFile() string  { return filepath.Join(s.d.Root, "volc-key.json") }
func (s *Service) localOnly() bool      { return s.d.LocalOnly != nil && s.d.LocalOnly() }
func (s *Service) audit(e AuditEvent) {
	if s.d.Audit != nil {
		s.d.Audit(e)
	}
}
func (s *Service) broadcast(ch string, payload any) { s.d.Publish(ch, payload) }

// ───────────── 豆包 API Key ─────────────

func (s *Service) volcKey() string {
	b, err := os.ReadFile(s.volcKeyFile())
	if err != nil {
		return ""
	}
	v, err := util.Parse(b)
	if err != nil {
		return ""
	}
	o, ok := v.(*util.Obj)
	if !ok {
		return ""
	}
	k, ok := o.Get("key").(string)
	if !ok || s.d.Secrets == nil {
		return ""
	}
	return s.d.Secrets.Decrypt(k)
}

func (s *Service) HasVolcKey() bool { return s.volcKey() != "" }

var jsWS = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`)

// SetVolcKey 返回 {ok, error?}
func (s *Service) SetVolcKey(raw any) *util.Obj {
	key := ""
	if str, ok := raw.(string); ok {
		key = util.JSTrim(str)
	}
	if key == "" || util.UTF16Len(key) > 256 || jsWS.MatchString(key) {
		return util.NewObj("ok", false, "error", s.d.T("electron.common.invalid-api-key-format"))
	}
	unavailable := s.d.T("electron.common.system-secure-storage-is-unavailable-so-the-api")
	if s.d.Secrets == nil || !s.d.Secrets.CanEncrypt() {
		return util.NewObj("ok", false, "error", unavailable)
	}
	enc, err := s.d.Secrets.Encrypt(key, unavailable)
	if err != nil {
		return util.NewObj("ok", false, "error", err.Error())
	}
	_ = os.MkdirAll(s.d.Root, 0o777)
	_ = os.WriteFile(s.volcKeyFile(), []byte(util.Stringify(util.NewObj("key", enc))), 0o600)
	s.audit(AuditEvent{Tool: "voice_volc_key", Args: util.NewObj("action", "set"), Decision: "user", Result: "ok"})
	s.broadcast("voice.changed", nil)
	return util.NewObj("ok", true)
}

func (s *Service) ClearVolcKey() bool {
	s.mu.Lock()
	s.cancelStreamsLocked()
	s.unlockCancel()
	_ = os.Remove(s.volcKeyFile())
	s.audit(AuditEvent{Tool: "voice_volc_key", Args: util.NewObj("action", "clear"), Decision: "user", Result: "ok"})
	s.broadcast("voice.changed", nil)
	return true
}

// ───────────── 设置 ─────────────

func (s *Service) load() Settings {
	b, err := os.ReadFile(s.settingsFile())
	if err != nil {
		return DefaultSettings()
	}
	v, err := util.Parse(b)
	if err != nil {
		return DefaultSettings()
	}
	return Sanitize(v, DefaultSettings())
}

func (s *Service) save() {
	_ = os.MkdirAll(s.d.Root, 0o777)
	f := s.settingsFile()
	_ = os.WriteFile(f, []byte(util.StringifyIndent(s.settings.Obj(), "  ")), 0o600)
}

func (s *Service) GetSettings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.effective(s.settings)
}

func (s *Service) effective(st Settings) Settings {
	if st.WakeWord.Phrase != "" {
		return st
	}
	p := ""
	if s.d.DefaultWakePhrase != nil {
		p = s.d.DefaultWakePhrase()
	}
	p = util.UTF16Slice0(util.JSTrim(p), 24)
	if p == "" {
		return st
	}
	st.WakeWord.Phrase = p
	return st
}

func (s *Service) SetSettings(patch any) Settings {
	s.mu.Lock()
	merged := s.settings.Obj()
	if p, ok := patch.(*util.Obj); ok {
		merged.Assign(p)
	}
	merged.Set("cloudAcked", s.settings.Obj().Get("cloudAcked"))
	s.settings = Sanitize(merged, s.settings)
	if s.settings.Engine != "volc" {
		s.cancelStreamsLocked()
	}
	s.save()
	eff := s.effective(s.settings)
	s.unlockCancel()
	s.broadcast("voice.changed", nil)
	return eff
}

func (s *Service) assetDir(a *Asset) string { return filepath.Join(s.modelsDir(), a.ID) }
func (s *Service) assetPath(a *Asset) string {
	if a.FileName != "" {
		return filepath.Join(s.assetDir(a), a.FileName)
	}
	return s.assetDir(a)
}

func (s *Service) installed(a *Asset) bool {
	if a.Kind == "whisper-bin" {
		return FindCliIn(s.assetDir(a)) != ""
	}
	return exists(s.assetPath(a))
}

// CliLoc = locateCli() 的结果
type CliLoc struct{ Path, Source string }

func (s *Service) env() map[string]string {
	if s.d.Env != nil {
		return s.d.Env()
	}
	m := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			m[kv[:i]] = kv[i+1:]
		}
	}
	return m
}

func (s *Service) locateCli(st Settings) *CliLoc {
	if st.WhisperCliPath != "" && exists(st.WhisperCliPath) {
		return &CliLoc{st.WhisperCliPath, "custom"}
	}
	for _, a := range AssetsFor(s.d.Platform) {
		if a.Kind != "whisper-bin" {
			continue
		}
		if p := FindCliIn(s.assetDir(&a)); p != "" {
			return &CliLoc{p, "downloaded"}
		}
	}
	if p := FindCliOnPath(s.env()); p != "" {
		return &CliLoc{p, "path"}
	}
	return nil
}

// Readiness = readiness()
type Readiness struct {
	OK      bool
	Code    string
	Message string
	Local   bool
}

// Obj：键序同 Node（ok, local, code?, message?）
func (r Readiness) Obj() *util.Obj {
	o := util.NewObj("ok", r.OK, "local", r.Local)
	if r.Code != "" {
		o.Set("code", r.Code)
		o.Set("message", r.Message)
	}
	return o
}

func (s *Service) readiness(st Settings) Readiness {
	t := s.d.T
	if st.Engine == "whisper-cpp" {
		if s.locateCli(st) == nil {
			msg := t("electron.common.the-whisper-cpp-engine-hasn-t-been-downloaded")
			if NodePlatform() == "darwin" {
				msg = t("electron.common.whisper-cpp-not-found-run-brew-install-whisper")
			}
			return Readiness{Local: true, Code: "no_engine", Message: msg}
		}
		if m := FindAsset(st.WhisperModel); m == nil || !s.installed(m) {
			return Readiness{Local: true, Code: "no_model", Message: t("electron.common.the-recognition-model-hasn-t-been-downloaded-yet")}
		}
		return Readiness{OK: true, Local: true}
	}
	if st.Engine == "volc" {
		if !s.HasVolcKey() {
			return Readiness{Code: "no_provider", Message: t("electron.common.enter-your-doubao-speech-api-key-in-the")}
		}
		if s.localOnly() {
			return Readiness{Code: "local_only", Message: t("electron.common.local-models-only-is-on-recordings-can-t")}
		}
		if !contains(st.CloudAcked, VolcTargetID) {
			return Readiness{Code: "cloud_not_acked", Message: t("electron.common.recordings-will-be-sent-to-for-recognition-please", t("electron.common.doubao-speech-volcengine"))}
		}
		return Readiness{OK: true}
	}
	tg := s.cloudTarget(st)
	if tg == nil {
		return Readiness{Code: "no_provider", Message: t("electron.common.please-choose-a-recognition-service")}
	}
	if !tg.local && s.localOnly() {
		return Readiness{Code: "local_only", Message: t("electron.common.local-models-only-is-on-recordings-can-t")}
	}
	if !tg.local && !contains(st.CloudAcked, CloudTargetID(st)) {
		return Readiness{Code: "cloud_not_acked", Message: t("electron.common.recordings-will-be-sent-to-for-recognition-please", tg.name)}
	}
	return Readiness{OK: true, Local: tg.local}
}

func contains(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}

var re127 = regexp.MustCompile(`^127\.`)

// IsLocalDefault = isLocalDefault(u)
func IsLocalDefault(u string) bool {
	p, err := url.Parse(util.JSTrim(u))
	if err != nil || p.Host == "" {
		return false
	}
	h := strings.ToLower(p.Hostname())
	return h == "localhost" || h == "::1" || re127.MatchString(h)
}

// urlHost = new URL(u).host
func urlHost(u string) string {
	o, ok := URLOrigin(u)
	if !ok {
		return ""
	}
	return o[strings.Index(o, "://")+3:]
}

type target struct {
	name, baseURL, apiKey string
	local                 bool
}

func (s *Service) isLocal(u string) bool {
	if s.d.IsLocalURL != nil {
		return s.d.IsLocalURL(u)
	}
	return IsLocalDefault(u)
}

func (s *Service) cloudTarget(st Settings) *target {
	if st.CustomBaseURL != "" {
		return &target{name: urlHost(st.CustomBaseURL), baseURL: st.CustomBaseURL, local: s.isLocal(st.CustomBaseURL)}
	}
	if st.ProviderID == "" || s.d.Credentials == nil {
		return nil
	}
	c := s.d.Credentials(st.ProviderID)
	if c == nil {
		return nil
	}
	return &target{name: c.Name, baseURL: c.BaseURL, apiKey: c.APIKey, local: s.isLocal(c.BaseURL)}
}

// AckCloud = ackCloud()
func (s *Service) AckCloud() Settings {
	s.mu.Lock()
	id := CloudTargetID(s.settings)
	added := false
	if id != "" && !contains(s.settings.CloudAcked, id) {
		s.settings.CloudAcked = append(append([]string{}, s.settings.CloudAcked...), id)
		s.save()
		added = true
	}
	out := s.settings
	s.mu.Unlock()
	if added {
		s.audit(AuditEvent{Tool: "voice_cloud_ack", Args: util.NewObj("target", id), Decision: "user", Result: "ok"})
	}
	return out
}

func (s *Service) localReady(st Settings) bool {
	m := FindAsset(st.WhisperModel)
	return s.locateCli(st) != nil && m != nil && s.installed(m)
}

func (s *Service) vadModelPath() string {
	a := FindAsset("silero-vad")
	if a != nil && s.installed(a) {
		return s.assetPath(a)
	}
	return ""
}

// State = state()
func (s *Service) State() *util.Obj {
	s.mu.Lock()
	st := s.settings
	act := s.activity
	dls := map[string][2]float64{}
	for k, v := range s.downloads {
		dls[k] = [2]float64{v.received, v.total}
	}
	s.mu.Unlock()
	assets := []any{}
	for _, a := range AssetsFor(s.d.Platform) {
		var downloading any
		if v, ok := dls[a.ID]; ok {
			downloading = util.NewObj("received", v[0], "total", v[1])
		}
		assets = append(assets, util.NewObj("id", a.ID, "kind", a.Kind, "name", a.Name, "description", a.Description,
			"bytes", float64(a.Bytes), "license", a.License, "licenseUrl", a.LicenseURL, "sourceUrl", a.SourceURL,
			"installed", s.installed(&a), "downloading", downloading))
	}
	var cli any
	if c := s.locateCli(st); c != nil {
		cli = util.NewObj("path", c.Path, "source", c.Source)
	}
	res := make([]any, len(VolcResources))
	for i, r := range VolcResources {
		res[i] = r
	}
	canStore := s.d.Secrets != nil && s.d.Secrets.CanEncrypt()
	providers := []any{}
	if s.d.Providers != nil {
		for _, p := range s.d.Providers() {
			providers = append(providers, util.NewObj("id", p.ID, "name", p.Name, "local", s.isLocal(p.BaseURL)))
		}
	}
	return util.NewObj(
		"settings", s.effective(st).Obj(),
		"platform", NodePlatform()+"-"+NodeArch(),
		"assets", assets,
		"cli", cli,
		"readiness", s.readiness(st).Obj(),
		"volc", util.NewObj("hasKey", s.HasVolcKey(), "host", VolcASRHost, "resources", res,
			"canStoreKey", canStore, "fallbackReady", s.localReady(st)),
		"vadReady", s.vadModelPath() != "",
		"providers", providers,
		"activity", act,
	)
}

func (s *Service) progress(id string, received, total float64, phase string, errMsg *string) {
	o := util.NewObj("id", id, "received", received, "total", total, "phase", phase)
	if errMsg != nil {
		o.Set("error", *errMsg)
	}
	s.broadcast("voice.progress", o)
}

func okRes() *util.Obj          { return util.NewObj("ok", true) }
func errRes(m string) *util.Obj { return util.NewObj("ok", false, "error", m) }

// Download = download(id)
func (s *Service) Download(id string) *util.Obj {
	a := FindAsset(id)
	applicable := false
	if a != nil {
		for _, x := range AssetsFor(s.d.Platform) {
			if x.ID == a.ID {
				applicable = true
			}
		}
	}
	if !applicable {
		return errRes(s.d.T("electron.common.unknown-resource-or-not-applicable-to-this-device"))
	}
	s.mu.Lock()
	if _, ok := s.downloads[id]; ok {
		s.mu.Unlock()
		return errRes(s.d.T("electron.common.downloading"))
	}
	ctx, cancel := context.WithCancel(context.Background())
	rec := &dl{cancel: cancel, ctx: ctx, total: float64(a.Bytes)}
	s.downloads[id] = rec
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.downloads, id)
		s.mu.Unlock()
		s.broadcast("voice.changed", nil)
	}()
	started := s.nowMs()
	s.progress(id, 0, rec.total, "start", nil)
	err := func() error {
		dir := s.assetDir(a)
		dest := s.assetPath(a)
		if a.Archive != "" {
			dest = filepath.Join(s.modelsDir(), a.ID+".download")
		}
		if err := DownloadVerified(ctx, DownloadOpts{URL: a.URL, Sha256: a.Sha256, Dest: dest, ExpectedBytes: a.Bytes,
			Fetch: s.d.Fetch, T: s.d.T, Now: s.d.Now,
			OnProgress: func(p Progress) {
				s.mu.Lock()
				rec.received = float64(p.Received)
				rec.total = float64(p.Total)
				if p.Total == 0 {
					rec.total = float64(a.Bytes)
				}
				r, t := rec.received, rec.total
				s.mu.Unlock()
				s.progress(id, r, t, "progress", nil)
			}}); err != nil {
			return err
		}
		if a.Archive != "" {
			buf, err := os.ReadFile(dest)
			if err != nil {
				return err
			}
			_ = os.RemoveAll(dir)
			if a.Archive == "zip" {
				_, err = ExtractZip(buf, dir)
			} else {
				_, err = ExtractTarGz(buf, dir)
			}
			if err != nil {
				return err
			}
			_ = os.Remove(dest)
			if FindCliIn(dir) == "" {
				return errors.New(s.d.T("electron.common.whisper-cli-not-found-after-unpacking"))
			}
		}
		return nil
	}()
	if err != nil {
		aborted := ctx.Err() != nil
		msg := err.Error()
		phase := "error"
		if aborted {
			msg = s.d.T("electron.common.cancelled")
			phase = "cancelled"
		}
		s.mu.Lock()
		r, t := rec.received, rec.total
		s.mu.Unlock()
		s.progress(id, r, t, phase, &msg)
		if !aborted {
			s.d.Logf("语音模型下载失败 id=%s error=%s", id, msg)
		}
		return errRes(msg)
	}
	ms := s.nowMs() - started
	s.audit(AuditEvent{Tool: "voice_model_download", Args: util.NewObj("id", id), Decision: "user", Result: "ok", Ms: &ms})
	s.mu.Lock()
	t := rec.total
	cur := FindAsset(s.settings.WhisperModel)
	s.mu.Unlock()
	s.progress(id, t, t, "done", nil)
	if a.Kind == "whisper-model" && (cur == nil || !s.installed(cur)) {
		s.SetSettings(util.NewObj("whisperModel", a.ID))
	}
	return okRes()
}

func (s *Service) Cancel(id string) bool {
	s.mu.Lock()
	d := s.downloads[id]
	s.mu.Unlock()
	if d != nil {
		d.cancel()
	}
	return d != nil
}

func (s *Service) Remove(id string) bool {
	a := FindAsset(id)
	if a == nil {
		return false
	}
	_ = os.RemoveAll(s.assetDir(a))
	s.broadcast("voice.changed", nil)
	return true
}

// Transcribe = transcribe(wav, opts)
func (s *Service) Transcribe(ctx context.Context, wav []byte, source, purpose string) (string, error) {
	s.mu.Lock()
	st := s.settings
	s.mu.Unlock()
	started := s.nowMs()
	engine := st.Engine
	if purpose == "wake" {
		engine = "whisper-cpp"
	}
	if wav == nil || len(wav) < 44+3200 {
		return "", &Error{"empty", s.d.T("electron.common.recording-too-short")}
	}
	if len(wav) > maxWavBytes {
		return "", &Error{"failed", s.d.T("electron.common.recording-too-long-max-about-13-minutes")}
	}
	var text string
	var err error
	fallback := false
	switch engine {
	case "whisper-cpp":
		text, err = s.localTranscribe(ctx, wav, purpose)
	case "volc":
		r := s.readiness(st)
		if !r.OK {
			return "", s.notReady(r)
		}
		pcm := wav[44:]
		text, err = s.volcBatch(st, pcm)
		if err != nil {
			s.mu.Lock()
			st2 := s.settings
			s.mu.Unlock()
			text, err = s.volcFallback(st2, err, pcm)
			fallback = true
		}
	default:
		r := s.readiness(st)
		if !r.OK {
			return "", s.notReady(r)
		}
		tg := s.cloudTarget(st)
		cctx, cancel := context.WithTimeout(ctx, 120*time.Second)
		text, err = s.d.Transcribe(cctx, CloudOpts{BaseURL: tg.baseURL, APIKey: tg.apiKey, Model: st.CloudModel,
			Wav: wav, Language: st.Language, T: s.d.T})
		cancel()
	}
	if err != nil {
		return "", err
	}
	if purpose != "wake" {
		args := util.NewObj("source", source, "engine", engine, "seconds", jsRound(float64(len(wav)-44)/32000))
		if fallback {
			args.Set("fallback", "whisper.cpp")
		}
		ms := s.nowMs() - started
		result := "empty"
		if text != "" {
			result = "ok"
		}
		prov := CloudTargetID(st)
		if engine == "whisper-cpp" {
			prov = "whisper.cpp"
		}
		s.audit(AuditEvent{Tool: "voice_transcribe", Args: args, Decision: "auto", Result: result, Ms: &ms, Provider: prov})
	}
	return text, nil
}

func jsRound(x float64) float64 {
	f := float64(int64(x))
	if x-f >= 0.5 {
		return f + 1
	}
	return f
}

func (s *Service) notReady(r Readiness) error {
	code, msg := r.Code, r.Message
	if code == "" {
		code = "failed"
	}
	if msg == "" {
		msg = s.d.T("electron.common.recognition-service-unavailable")
	}
	return &Error{code, msg}
}

var reHan = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)

func (s *Service) localTranscribe(ctx context.Context, wav []byte, purpose string) (string, error) {
	s.mu.Lock()
	st := s.effective(s.settings)
	s.mu.Unlock()
	cli := s.locateCli(st)
	if cli == nil {
		return "", &Error{"no_engine", s.d.T("electron.common.whisper-cpp-engine-not-found")}
	}
	m := FindAsset(st.WhisperModel)
	if m == nil || !s.installed(m) {
		return "", &Error{"no_model", s.d.T("electron.common.recognition-model-not-downloaded-yet")}
	}
	han := reHan.MatchString(st.WakeWord.Phrase)
	lang := st.Language
	if purpose == "wake" && st.Language == "auto" && han {
		lang = "zh"
	}
	prompt := ""
	if st.Language == "zh" || (purpose == "wake" && han) {
		prompt = "以下是普通话的句子。" // i18n-ignore
	}
	to := 120 * time.Second
	if purpose == "wake" {
		to = 20 * time.Second
	}
	return s.d.Whisper(ctx, WhisperOpts{Cli: cli.Path, Model: s.assetPath(m), Wav: wav, Language: lang, Prompt: prompt, Timeout: to, T: s.d.T})
}

// TranscribeResult = transcribeResult(wav, opts)
func (s *Service) TranscribeResult(ctx context.Context, wav []byte, source, purpose string) *util.Obj {
	text, err := s.Transcribe(ctx, wav, source, purpose)
	if err != nil {
		code := "failed"
		var ve *Error
		if errors.As(err, &ve) {
			code = ve.Code
		}
		return util.NewObj("ok", false, "code", code, "error", err.Error())
	}
	return util.NewObj("ok", true, "text", text)
}

var activities = map[string]bool{"idle": true, "listening": true, "hearing": true, "transcribing": true, "wake-armed": true}

func (s *Service) setActivity(a, source string) {
	s.mu.Lock()
	prev := s.activity
	s.activity = a
	barge := s.settings.BargeIn
	s.mu.Unlock()
	s.broadcast("voice.activity", util.NewObj("activity", a, "source", source))
	ptt := strings.HasSuffix(source, ":ptt")
	if a == "listening" && ptt && prev != a && s.d.SendToMascot != nil {
		s.d.SendToMascot(util.NewObj("type", "reply-speech", "op", "stop"))
	}
	if barge && (a == "hearing" || (a == "listening" && ptt)) && prev != a {
		s.broadcast("voice.bargeIn", util.NewObj("source", source))
	}
}

// ReportActivity = reportActivity(a, source)
func (s *Service) ReportActivity(a any, source any) bool {
	as := jsString(a)
	if !activities[as] {
		return false
	}
	src := ""
	if source != nil {
		if _, u := source.(util.JSUndefined); !u {
			src = jsString(source)
		}
	}
	s.setActivity(as, src)
	return true
}

func jsString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case nil:
		return "null"
	case util.JSUndefined:
		return "undefined"
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return util.FormatNumber(x)
	}
	return "[object Object]"
}

// SendToChat = sendToChat(text)
func (s *Service) SendToChat(text string) {
	if s.d.OpenChat == nil || util.JSTrim(text) == "" {
		return
	}
	onceLoaded := s.d.OpenChat()
	s.mu.Lock()
	auto := s.settings.AutoSend
	s.mu.Unlock()
	payload := util.NewObj("text", util.JSTrim(text), "autoSend", auto)
	deliver := func() {
		if s.d.PublishChat != nil {
			s.d.PublishChat("voice.inject", payload)
		}
	}
	if onceLoaded != nil {
		onceLoaded(func() { time.AfterFunc(500*time.Millisecond, deliver) })
	} else {
		deliver()
	}
}

// PcmToWav = pcmToWav(pcm)
func PcmToWav(pcm []byte) []byte {
	out := make([]byte, 44+len(pcm))
	copy(out[0:], "RIFF")
	binary.LittleEndian.PutUint32(out[4:], uint32(36+len(pcm)))
	copy(out[8:], "WAVE")
	copy(out[12:], "fmt ")
	binary.LittleEndian.PutUint32(out[16:], 16)
	binary.LittleEndian.PutUint16(out[20:], 1)
	binary.LittleEndian.PutUint16(out[22:], 1)
	binary.LittleEndian.PutUint32(out[24:], 16000)
	binary.LittleEndian.PutUint32(out[28:], 32000)
	binary.LittleEndian.PutUint16(out[32:], 2)
	binary.LittleEndian.PutUint16(out[34:], 16)
	copy(out[36:], "data")
	binary.LittleEndian.PutUint32(out[40:], uint32(len(pcm)))
	copy(out[44:], pcm)
	return out
}
