package local

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
)

var T i18n.Translate = i18n.Identity

func SetTranslator(t i18n.Translate) {
	if t != nil {
		T = t
	}
}

// GatewayLike：GatewayService 的最小子集
type GatewayProvider struct {
	ID       string `json:"id"`
	PresetID string `json:"presetId,omitempty"`
}
type GatewayModel struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
}
type GatewayUpsert struct {
	ID       string            `json:"id,omitempty"`
	Name     string            `json:"name"`
	PresetID string            `json:"presetId,omitempty"`
	URLs     map[string]string `json:"urls"`
	Models   []GatewayModel    `json:"models"`
}
type GatewayLike interface {
	Providers() []GatewayProvider
	UpsertProvider(in GatewayUpsert) (string, error)
	SetNomiMain(model string) error
	ConfirmPrivateHost(hostPort string) error
}

// LocalDesktop：desktop.say + broker.localOnly / setLocalOnly
type LocalDesktop interface {
	deps.Audit
	Say(text string)
	LocalOnly() bool
	SetLocalOnly(on bool)
}

type Deps struct {
	Root     string
	Logger   deps.Logger
	Desktop  LocalDesktop
	Gateway  func() GatewayLike
	Client   *http.Client
	Events   deps.Events
	Download knowledge.Downloader
	TotalMem func() uint64
}

// Settings：字段顺序 = Node 构造函数字面量顺序；undefined → 省略
type Settings struct {
	ActiveModel       *string `json:"activeModel,omitempty"`
	AutoStart         bool    `json:"autoStart"`
	ProviderID        *string `json:"providerId,omitempty"`
	GatewayProviderID *string `json:"gatewayProviderId,omitempty"`
	Threads           *int    `json:"threads,omitempty"`
	OllamaURL         string  `json:"ollamaUrl"`
}

const (
	ProviderName  = "electron.common.llama-cpp-local"
	LocalPresetID = "llamacpp"
	RuntimeID     = "llama-runtime"
)

var httpRe = regexp.MustCompile(`^https?://`)
var ollamaNameRe = regexp.MustCompile(`^[\w.\-/:]+$`)

type dl struct {
	cancel   context.CancelFunc
	ctx      context.Context
	received int64
	total    int64
}

type Service struct {
	d         Deps
	mu        sync.Mutex
	settings  Settings
	downloads map[string]*dl
	proc      *exec.Cmd
	exited    chan struct{}
	status    string
	port      int
	running   string
	lastError string
	log       []string
}

func New(d Deps) *Service {
	if d.Client == nil {
		d.Client = http.DefaultClient
	}
	if d.Download == nil {
		d.Download = knowledge.DownloadVerified
	}
	if d.TotalMem == nil {
		d.TotalMem = totalMem
	}
	if d.Logger == nil {
		d.Logger = deps.StdLogger{Prefix: "[local]"}
	}
	s := &Service{d: d, downloads: map[string]*dl{}, status: "stopped"}
	_ = os.MkdirAll(s.modelsDir(), 0o755)
	raw := map[string]any{}
	if b, err := os.ReadFile(s.settingsFile()); err == nil {
		if v, err := deps.ParseJSON(b); err == nil {
			if m, ok := v.(map[string]any); ok {
				raw = m
			}
		}
	}
	if v, ok := raw["activeModel"].(string); ok {
		s.settings.ActiveModel = &v
	}
	s.settings.AutoStart = raw["autoStart"] == true
	if v, ok := raw["providerId"].(string); ok {
		s.settings.ProviderID = &v
	}
	if v, ok := raw["gatewayProviderId"].(string); ok {
		s.settings.GatewayProviderID = &v
	}
	if v, ok := isInt(raw["threads"]); ok {
		s.settings.Threads = &v
	}
	s.settings.OllamaURL = "http://127.0.0.1:11434"
	if v, ok := raw["ollamaUrl"].(string); ok && httpRe.MatchString(v) {
		s.settings.OllamaURL = v
	}
	return s
}

func isInt(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != float64(int64(f)) {
		return 0, false
	}
	return int(f), true
}

func (s *Service) settingsFile() string { return filepath.Join(s.d.Root, "settings.json") }
func (s *Service) modelsDir() string    { return filepath.Join(s.d.Root, "models") }
func (s *Service) runtimeDir() string   { return filepath.Join(s.d.Root, "llama.cpp", LlamaTag) }
func (s *Service) save() {
	b, _ := deps.Stringify(s.settings, "  ")
	_ = os.WriteFile(s.settingsFile(), b, 0o644)
}
func (s *Service) pub(ev string, p any) {
	if s.d.Events != nil {
		s.d.Events.Publish(ev, p)
	}
}
func (s *Service) changed() { s.pub("local.changed", nil) }
func (s *Service) audit(tool string, args any, result string, ms int64) {
	if s.d.Desktop != nil {
		s.d.Desktop.Append(deps.AuditEntry{Tool: tool, Args: args, Decision: "user", Result: result, Ms: &ms, Source: "settings"})
	}
}

func (s *Service) ModelPath(m LocalLlm) string { return filepath.Join(s.modelsDir(), m.ID+".gguf") }
func (s *Service) Installed(m LocalLlm) bool {
	st, err := os.Stat(s.ModelPath(m))
	return err == nil && st.Size() == m.Bytes
}
func (s *Service) ServerBin() string {
	for _, n := range ServerNames() {
		for _, p := range []string{filepath.Join(s.runtimeDir(), n), filepath.Join(s.runtimeDir(), "bin", n), filepath.Join(s.runtimeDir(), "build", "bin", n)} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}

func findLlm(id string) *LocalLlm {
	for i := range LocalLlms {
		if LocalLlms[i].ID == id {
			m := LocalLlms[i]
			return &m
		}
	}
	return nil
}

type DlView struct {
	Received int64 `json:"received"`
	Total    int64 `json:"total"`
}
type ModelView struct {
	LocalLlm
	Installed   bool    `json:"installed"`
	Fit         string  `json:"fit"`
	Downloading *DlView `json:"downloading,omitempty"`
}
type RuntimeView struct {
	Tag         string  `json:"tag"`
	License     string  `json:"license"`
	LicenseURL  string  `json:"licenseUrl"`
	SourceURL   string  `json:"sourceUrl"`
	Supported   bool    `json:"supported"`
	Bytes       int64   `json:"bytes"`
	Installed   bool    `json:"installed"`
	Downloading *DlView `json:"downloading,omitempty"`
}
type ServerView struct {
	Status  string   `json:"status"`
	Model   string   `json:"model,omitempty"`
	Port    int      `json:"port,omitempty"`
	BaseURL string   `json:"baseURL,omitempty"`
	Error   string   `json:"error,omitempty"`
	Log     []string `json:"log"`
}
type State struct {
	RamGb       int64       `json:"ramGb"`
	Recommended string      `json:"recommended"`
	Models      []ModelView `json:"models"`
	Runtime     RuntimeView `json:"runtime"`
	Server      ServerView  `json:"server"`
	Settings    Settings    `json:"settings"`
	Offline     bool        `json:"offline"`
}

func (s *Service) dlView(id string) *DlView {
	if r, ok := s.downloads[id]; ok {
		return &DlView{r.received, r.total}
	}
	return nil
}

func (s *Service) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stateLocked()
}

func (s *Service) stateLocked() State {
	ram := float64(s.d.TotalMem()) / float64(1<<30)
	ramGb := int64(float64(ram) + 0.5) // Math.round（正数）
	rec := Recommend(float64(ramGb), nil)
	rt := RuntimeFor(NodePlatform(), NodeArch())
	models := make([]ModelView, 0, len(LocalLlms))
	for _, m := range LocalLlms {
		models = append(models, ModelView{m, s.Installed(m), FitLevel(m, float64(ramGb)), s.dlView(m.ID)})
	}
	var rtBytes int64
	if rt != nil {
		rtBytes = rt.Bytes
	}
	lg := s.log
	if len(lg) > 8 {
		lg = lg[len(lg)-8:]
	}
	lg = append([]string{}, lg...)
	sv := ServerView{Status: s.status, Model: s.running, Port: s.port, Error: s.lastError, Log: lg}
	if s.port != 0 {
		sv.BaseURL = fmt.Sprintf("http://127.0.0.1:%d/v1", s.port)
	}
	off := false
	if s.d.Desktop != nil {
		off = s.d.Desktop.LocalOnly()
	}
	return State{ramGb, rec.ID, models, RuntimeView{LlamaRuntime.Tag, LlamaRuntime.License, LlamaRuntime.LicenseURL, LlamaRuntime.SourceURL, rt != nil, rtBytes, s.ServerBin() != "", s.dlView(RuntimeID)}, sv, s.settings, off}
}

// SetSettings：p 是原始 JSON 对象（区分 undefined 与缺省）
func (s *Service) SetSettings(p map[string]any) Settings {
	s.mu.Lock()
	if v, ok := p["autoStart"].(bool); ok {
		s.settings.AutoStart = v
	}
	if tv, present := p["threads"]; !present || tv == nil {
		// Node：p.threads === undefined → 清空（JSON null 也视为缺省）
		s.settings.Threads = nil
	} else if n, ok := isInt(tv); ok && n > 0 && n <= 64 {
		s.settings.Threads = &n
	}
	if v, ok := p["ollamaUrl"].(string); ok && httpRe.MatchString(v) {
		s.settings.OllamaURL = strings.TrimRight(v, "/")
	}
	s.save()
	out := s.settings
	s.mu.Unlock()
	s.changed()
	return out
}

type Result struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func (s *Service) Download(id string) Result {
	isRuntime := id == RuntimeID
	m := findLlm(id)
	rt := RuntimeFor(NodePlatform(), NodeArch())
	if !isRuntime && m == nil {
		return Result{false, T("electron.common.unknown-model")}
	}
	if isRuntime && rt == nil {
		return Result{false, T("electron.common.no-prebuilt-llama-cpp-for-this-computer-s")}
	}
	s.mu.Lock()
	if _, ok := s.downloads[id]; ok {
		s.mu.Unlock()
		return Result{false, T("electron.common.downloading")}
	}
	ctx, cancel := context.WithCancel(context.Background())
	var total int64
	var u, sha, dest string
	if isRuntime {
		total, u, sha, dest = rt.Bytes, rt.URL, rt.Sha256, filepath.Join(s.d.Root, RuntimeID+".download")
	} else {
		total, u, sha, dest = m.Bytes, m.URL, m.Sha256, s.ModelPath(*m)
	}
	rec := &dl{cancel: cancel, ctx: ctx, total: total}
	s.downloads[id] = rec
	s.mu.Unlock()
	s.changed()
	t0 := time.Now()
	defer func() {
		s.mu.Lock()
		delete(s.downloads, id)
		s.mu.Unlock()
		cancel()
		s.changed()
	}()
	err := s.d.Download(ctx, u, sha, dest, total, func(recv, tot int64) {
		s.mu.Lock()
		rec.received = recv
		if tot != 0 {
			rec.total = tot
		} else {
			rec.total = total
		}
		r, t := rec.received, rec.total
		s.mu.Unlock()
		s.pub("local.progress", map[string]any{"id": id, "received": r, "total": t})
	})
	if err == nil && isRuntime {
		err = s.installRuntime(dest, rt.Archive)
	}
	if err != nil {
		if ctx.Err() != nil {
			return Result{false, T("electron.common.cancelled")}
		}
		s.d.Logger.Warn("本地模型下载失败", "id", id, "error", err.Error())
		return Result{false, err.Error()}
	}
	s.audit("local_model_download", deps.O("id", id), "ok", time.Since(t0).Milliseconds())
	deps.AvatarGesture(s.d.Events, "clap")
	return Result{OK: true}
}

func (s *Service) installRuntime(dest, archive string) error {
	buf, err := os.ReadFile(dest)
	if err != nil {
		return err
	}
	_ = os.RemoveAll(s.runtimeDir())
	if archive == "zip" {
		_, err = voice.ExtractZip(buf, s.runtimeDir())
	} else {
		_, err = voice.ExtractTarGz(buf, s.runtimeDir())
	}
	if err != nil {
		return err
	}
	_ = os.Remove(dest)
	bin := s.ServerBin()
	if bin == "" {
		return errors.New(T("electron.common.llama-server-not-found-after-unpacking"))
	}
	if NodePlatform() != "win32" {
		_ = os.Chmod(bin, 0o755)
	}
	return nil
}

func (s *Service) DownloadRuntime() Result { return s.Download(RuntimeID) }

func (s *Service) Cancel(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.downloads[id]
	if ok {
		r.cancel()
	}
	return ok
}

func (s *Service) Remove(id string) bool {
	m := findLlm(id)
	if m == nil {
		return false
	}
	s.mu.Lock()
	running := s.running
	s.mu.Unlock()
	if running == id {
		s.Stop()
	}
	_ = os.Remove(s.ModelPath(*m))
	s.mu.Lock()
	if s.settings.ActiveModel != nil && *s.settings.ActiveModel == id {
		s.settings.ActiveModel = nil
	}
	s.save()
	s.mu.Unlock()
	s.audit("local_model_remove", deps.O("id", id), "ok", 0)
	s.changed()
	return true
}

func (s *Service) RemoveRuntime() (bool, error) {
	s.mu.Lock()
	if s.proc != nil {
		s.mu.Unlock()
		return false, errors.New(T("electron.common.please-stop-the-local-model-first"))
	}
	s.mu.Unlock()
	_ = os.RemoveAll(filepath.Dir(s.runtimeDir()))
	s.changed()
	return true, nil
}

type StartResult struct {
	BaseURL    string `json:"baseURL"`
	ProviderID string `json:"providerId"`
}

type logWriter struct{ s *Service }

func (w logWriter) Write(b []byte) (int, error) {
	w.s.mu.Lock()
	defer w.s.mu.Unlock()
	for _, line := range strings.Split(string(b), "\n") {
		if deps.Trim(line) != "" {
			w.s.log = append(w.s.log, deps.Slice0(line, 200))
		}
	}
	if len(w.s.log) > 200 {
		w.s.log = append([]string{}, w.s.log[len(w.s.log)-100:]...)
	}
	return len(b), nil
}

func (s *Service) Start(id string) (StartResult, error) {
	m := findLlm(id)
	if m == nil || !s.Installed(*m) {
		return StartResult{}, errors.New(T("electron.common.please-download-this-model-first"))
	}
	bin := s.ServerBin()
	if bin == "" {
		return StartResult{}, errors.New(T("electron.common.please-download-the-llama-cpp-inference-engine-first"))
	}
	s.mu.Lock()
	has := s.proc != nil
	s.mu.Unlock()
	if has {
		s.Stop()
	}
	port, err := freePort()
	if err != nil {
		return StartResult{}, err
	}
	s.mu.Lock()
	s.status, s.lastError, s.log, s.port, s.running = "starting", "", nil, port, id
	threads := 0
	if s.settings.Threads != nil {
		threads = *s.settings.Threads
	}
	s.mu.Unlock()
	s.changed()
	cmd := exec.Command(bin, ServerArgs(s.ModelPath(*m), port, m.Ctx, threads)...)
	cmd.Dir = filepath.Dir(bin)
	ld := filepath.Dir(bin)
	if v := os.Getenv("LD_LIBRARY_PATH"); v != "" {
		ld += ":" + v
	}
	cmd.Env = append(os.Environ(), "LD_LIBRARY_PATH="+ld)
	cmd.Stdout, cmd.Stderr = logWriter{s}, logWriter{s}
	hideWindow(cmd)
	exited := make(chan struct{})
	if err := cmd.Start(); err != nil {
		s.mu.Lock()
		s.status = "error"
		s.lastError = T("electron.common.couldn-t-start-llama-server", err.Error())
		s.mu.Unlock()
		s.changed()
	} else {
		s.mu.Lock()
		s.proc, s.exited = cmd, exited
		s.mu.Unlock()
		go func() {
			_ = cmd.Wait()
			close(exited)
			s.mu.Lock()
			if s.proc != cmd {
				s.mu.Unlock()
				return
			}
			s.proc = nil
			if s.status != "stopped" {
				s.status = "error"
				lg := s.log
				if len(lg) > 2 {
					lg = lg[len(lg)-2:]
				}
				s.lastError = T("electron.common.the-inference-server-exited-unexpectedly-code", exitCode(cmd), deps.Slice0(strings.Join(lg, " "), 200))
			}
			s.mu.Unlock()
			s.changed()
		}()
	}
	t0 := time.Now()
	if !s.waitHealthy(90 * time.Second) {
		s.mu.Lock()
		e := s.lastError
		s.mu.Unlock()
		if e == "" {
			e = T("electron.common.the-inference-server-timed-out-while-starting")
		}
		s.Stop()
		s.mu.Lock()
		s.status, s.lastError = "error", e
		s.mu.Unlock()
		s.changed()
		return StartResult{}, errors.New(e)
	}
	s.mu.Lock()
	s.status = "running"
	s.mu.Unlock()
	baseURL := fmt.Sprintf("http://127.0.0.1:%d/v1", port)
	pid, err := s.registerInGateway(*m, baseURL)
	if err != nil {
		return StartResult{}, err
	}
	s.mu.Lock()
	s.settings.ProviderID, s.settings.GatewayProviderID = &pid, &pid
	s.save()
	aid := id
	s.settings.ActiveModel = &aid
	s.save()
	s.mu.Unlock()
	s.audit("local_model_start", deps.O("id", id, "port", port), "ok", time.Since(t0).Milliseconds())
	deps.AvatarGesture(s.d.Events, "nod")
	if s.d.Desktop != nil {
		s.d.Desktop.Say(T("electron.common.local-model-is-ready-your-chats-won-t", m.Name))
	}
	s.changed()
	return StartResult{baseURL, pid}, nil
}

func exitCode(c *exec.Cmd) any {
	if c.ProcessState == nil {
		return nil
	}
	if ws, ok := c.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return nil // Node：被信号杀死时 code 为 null（signal 有值）
	}
	// Windows 没有信号：外部 TerminateProcess 结束时 libuv 同样只给退出码，signal 为 null

	return c.ProcessState.ExitCode()
}

func (s *Service) waitHealthy(timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		s.mu.Lock()
		alive, port := s.proc != nil, s.port
		s.mu.Unlock()
		if !alive {
			return false
		}
		if r, err := s.d.Client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port)); err == nil {
			r.Body.Close()
			if r.StatusCode >= 200 && r.StatusCode <= 299 {
				return true
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

func (s *Service) registerInGateway(m LocalLlm, baseURL string) (string, error) {
	var gw GatewayLike
	if s.d.Gateway != nil {
		gw = s.d.Gateway()
	}
	if gw == nil {
		return "", errors.New(T("electron.common.ai-service-not-ready"))
	}
	u, _ := url.Parse(baseURL)
	p := u.Port()
	if p == "" {
		p = "80"
	}
	id, err := func() (string, error) {
		if err := gw.ConfirmPrivateHost(u.Hostname() + ":" + p); err != nil {
			return "", err
		}
		s.mu.Lock()
		gpid := ""
		if s.settings.GatewayProviderID != nil {
			gpid = *s.settings.GatewayProviderID
		}
		s.mu.Unlock()
		in := GatewayUpsert{Name: T(ProviderName), PresetID: LocalPresetID, URLs: map[string]string{"chat": baseURL}, Models: []GatewayModel{{m.ID, true}}}
		for _, pv := range gw.Providers() {
			if (gpid != "" && pv.ID == gpid) || pv.PresetID == LocalPresetID {
				in.ID = pv.ID
				break
			}
		}
		return gw.UpsertProvider(in)
	}()
	if err != nil {
		s.d.Logger.Warn("register local model in gateway failed", "error", err.Error())
	}
	return id, err
}

func (s *Service) Stop() bool {
	s.mu.Lock()
	p, ex := s.proc, s.exited
	s.status, s.proc, s.running, s.port = "stopped", nil, "", 0
	s.mu.Unlock()
	if p != nil && p.Process != nil && p.ProcessState == nil {
		_ = terminate(p.Process)
		select {
		case <-ex:
		case <-time.After(3 * time.Second):
			_ = p.Process.Kill()
		}
	}
	s.changed()
	return true
}

func (s *Service) UseAsChat() (bool, error) {
	var gw GatewayLike
	if s.d.Gateway != nil {
		gw = s.d.Gateway()
	}
	s.mu.Lock()
	gpid, st, run := s.settings.GatewayProviderID, s.status, s.running
	s.mu.Unlock()
	if gw == nil || gpid == nil || *gpid == "" || st != "running" || run == "" {
		return false, errors.New(T("electron.common.the-local-model-isn-t-running-yet"))
	}
	if err := gw.SetNomiMain(*gpid + "/" + run); err != nil {
		return false, err
	}
	s.changed()
	return true, nil
}

func (s *Service) SetOffline(on bool) (bool, error) {
	if s.d.Desktop != nil {
		s.d.Desktop.SetLocalOnly(on)
		s.d.Desktop.Append(deps.AuditEntry{Tool: "set_local_only", Args: deps.O("v", on), Decision: "user", Result: "ok", Source: "settings"})
	}
	s.mu.Lock()
	st := s.status
	s.mu.Unlock()
	if on && st == "running" {
		if _, err := s.UseAsChat(); err != nil {
			return false, err
		}
	}
	s.audit("offline_mode", deps.O("on", on), "ok", 0)
	s.changed()
	return s.State().Offline, nil
}

func (s *Service) AutoStart() {
	s.mu.Lock()
	id, on := s.settings.ActiveModel, s.settings.AutoStart
	s.mu.Unlock()
	if on && id != nil && *id != "" {
		if _, err := s.Start(*id); err != nil {
			s.d.Logger.Warn("本地模型自动启动失败", "error", "Error: "+err.Error())
		}
	}
}

// ───────────── Ollama ─────────────

func (s *Service) ollamaURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings.OllamaURL
}

type OllamaModel struct {
	Name       string  `json:"name"`
	Size       float64 `json:"size"`
	ModifiedAt string  `json:"modifiedAt"`
	Params     string  `json:"params,omitempty"`
	Quant      string  `json:"quant,omitempty"`
	Family     string  `json:"family,omitempty"`
}

func (s *Service) OllamaList() ([]OllamaModel, error) {
	r, err := s.d.Client.Get(s.ollamaURL() + "/api/tags")
	if err != nil {
		return nil, errors.New(T("electron.common.ollama-not-detected-please-install-and-start-ollama"))
	}
	defer r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return nil, errors.New(T("electron.common.ollama-returned-http", r.StatusCode))
	}
	var j struct {
		Models []struct {
			Name       string  `json:"name"`
			Size       float64 `json:"size"`
			ModifiedAt string  `json:"modified_at"`
			Details    *struct {
				ParameterSize     string `json:"parameter_size"`
				QuantizationLevel string `json:"quantization_level"`
				Family            string `json:"family"`
			} `json:"details"`
		} `json:"models"`
	}
	if err := json.NewDecoder(r.Body).Decode(&j); err != nil {
		return nil, err
	}
	out := make([]OllamaModel, 0, len(j.Models))
	for _, m := range j.Models {
		o := OllamaModel{Name: m.Name, Size: m.Size, ModifiedAt: m.ModifiedAt}
		if m.Details != nil {
			o.Params, o.Quant, o.Family = m.Details.ParameterSize, m.Details.QuantizationLevel, m.Details.Family
		}
		out = append(out, o)
	}
	return out, nil
}

func (s *Service) OllamaPull(name string) (bool, error) {
	if !ollamaNameRe.MatchString(name) {
		return false, errors.New(T("electron.common.model-names-may-only-contain-letters-digits-and"))
	}
	id := "ollama:" + name
	s.mu.Lock()
	if _, ok := s.downloads[id]; ok {
		s.mu.Unlock()
		return false, errors.New(T("electron.common.pulling"))
	}
	ctx, cancel := context.WithCancel(context.Background())
	rec := &dl{cancel: cancel, ctx: ctx}
	s.downloads[id] = rec
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.downloads, id)
		s.mu.Unlock()
		cancel()
		s.changed()
	}()
	body, _ := json.Marshal(map[string]any{"name": name, "stream": true})
	req, _ := http.NewRequestWithContext(ctx, "POST", s.ollamaURL()+"/api/pull", bytes.NewReader(body))
	r, err := s.d.Client.Do(req)
	if err != nil {
		return false, errors.New(T("electron.common.ollama-not-detected-install-first"))
	}
	defer r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return false, errors.New(T("electron.common.ollama-pull-failed-http", r.StatusCode))
	}
	sc := bufio.NewScanner(r.Body)
	sc.Buffer(make([]byte, 64*1024), 8<<20)
	for sc.Scan() {
		line := sc.Text()
		if deps.Trim(line) == "" {
			continue
		}
		var j struct {
			Status    *string `json:"status"`
			Completed float64 `json:"completed"`
			Total     float64 `json:"total"`
			Error     string  `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &j); err != nil {
			return false, err
		}
		if j.Error != "" {
			return false, errors.New(j.Error)
		}
		s.mu.Lock()
		if j.Total != 0 {
			rec.total, rec.received = int64(j.Total), int64(j.Completed)
		}
		p := map[string]any{"id": id, "received": rec.received, "total": rec.total}
		s.mu.Unlock()
		if j.Status != nil {
			p["status"] = *j.Status
		}
		s.pub("local.progress", p)
	}
	if err := sc.Err(); err != nil {
		return false, err
	}
	s.audit("ollama_pull", deps.O("name", name), "ok", 0)
	return true, nil
}

func (s *Service) OllamaDelete(name string) (bool, error) {
	body, _ := json.Marshal(map[string]any{"name": name})
	req, _ := http.NewRequest("DELETE", s.ollamaURL()+"/api/delete", bytes.NewReader(body))
	r, err := s.d.Client.Do(req)
	if err != nil {
		return false, err
	}
	r.Body.Close()
	if r.StatusCode < 200 || r.StatusCode > 299 {
		return false, errors.New(T("electron.common.delete-failed-http", r.StatusCode))
	}
	s.audit("ollama_delete", deps.O("name", name), "ok", 0)
	s.changed()
	return true, nil
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
