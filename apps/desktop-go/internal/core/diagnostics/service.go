package diagnostics

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
)

const (
	file        = "diagnostics.json"
	observeFile = "observe.json"
)

// View = DiagnosticsView（字段序同 Node 对象字面量）
type View struct {
	Enabled   bool   `json:"enabled"`
	Forced    bool   `json:"forced"`
	SaveLogs  bool   `json:"saveLogs"`
	Dir       string `json:"dir"`
	BodyTrace bool   `json:"bodyTrace"`
}

// ExportResult = DiagnosticsExportResult
type ExportResult struct {
	OK    bool      `json:"ok"`
	Path  string    `json:"path,omitempty"`
	Files *[]string `json:"files,omitempty"`
	Error string    `json:"error,omitempty"`
}

type FileFilter struct {
	Name       string
	Extensions []string
}

// Ports = Pick<HostPorts, 'app' | 'dialogs' | 'shell'> 中用到的部分
type Ports struct {
	IsPackaged func() bool
	Version    func() string
	// SaveFile：dialogs.saveFile({ title, defaultPath, filters, parent: 'focused' })；取消返回 ""
	SaveFile func(title, defaultPath string, filters []FileFilter) (string, error)
	// OpenPath：shell.openPath，返回错误文本（成功为 ""）
	OpenPath func(p string) string
}

type Logger interface {
	Info(msg string, kv ...any)
	Warn(msg string, kv ...any)
}

// SetLevel：logger.setLevel(DEBUG|INFO)；nil = 宿主没有可调级别的日志器
type Deps struct {
	UserData      string
	Logger        Logger
	Ports         Ports
	Dev           *bool
	OnChange      func(enabled bool)
	LegacyEnabled func() bool
	TraceDir      string
	Env           map[string]string
	Now           func() int64
	SetLevel      func(debug bool)
	Platform      string
}

type Service struct {
	d        Deps
	mu       sync.Mutex
	saveLogs bool
	forced   bool
	file     string
	logDir   string
	// FlushTrace：exportBundle 打包前写完缓冲的编程助手收发记录（= cliTrace.flush）
	FlushTrace func()
	// CliTrace：编程助手子进程收发记录（spawnHarness 经 harness.CliTrap 挂上）
	CliTrace *CliTrace
}

func New(d Deps) *Service {
	s := &Service{d: d}
	if d.Dev != nil {
		s.forced = *d.Dev
	} else {
		s.forced = d.Ports.IsPackaged == nil || !d.Ports.IsPackaged()
	}
	s.file = filepath.Join(d.UserData, file)
	s.logDir = filepath.Join(d.UserData, "logs")
	s.CliTrace = NewCliTrace(s.logDir, s.Enabled)
	s.FlushTrace = s.CliTrace.Flush
	s.saveLogs = s.load()
	s.apply()
	return s
}

func (s *Service) LogDir() string { return s.logDir }

func (s *Service) Enabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.forced || s.saveLogs
}

func (s *Service) env(k string) (string, bool) {
	if s.d.Env != nil {
		v, ok := s.d.Env[k]
		return v, ok
	}
	return os.LookupEnv(k)
}

func (s *Service) BodyTrace() bool {
	v, ok := s.env("NOMI_DIAG_BODY")
	return s.Enabled() && !(ok && v == "0")
}

func (s *Service) View() View {
	en := s.Enabled()
	s.mu.Lock()
	sl := s.saveLogs
	s.mu.Unlock()
	return View{Enabled: en, Forced: s.forced, SaveLogs: sl, Dir: s.logDir, BodyTrace: s.BodyTrace()}
}

var isoPunct = regexp.MustCompile(`[:.]`)

func (s *Service) now() int64 {
	if s.d.Now != nil {
		return s.d.Now()
	}
	return time.Now().UnixMilli()
}

func (s *Service) platform() string {
	if s.d.Platform != "" {
		return s.d.Platform
	}
	return NodePlatform(runtime.GOOS)
}

// NodePlatform：GOOS → process.platform
func NodePlatform(goos string) string {
	if goos == "windows" {
		return "win32"
	}
	return goos
}

func (s *Service) ExportBundle() ExportResult {
	now := s.now()
	iso, _ := util.ToISOString(float64(now))
	name := "nomi-diagnostics-" + isoPunct.ReplaceAllString(iso, "-") + ".zip"
	var f string
	if s.d.Ports.SaveFile != nil {
		f, _ = s.d.Ports.SaveFile(i18n.T("electron.common.export-diagnostics-bundle"), name, []FileFilter{{Name: "Zip", Extensions: []string{"zip"}}})
	}
	if f == "" {
		return ExportResult{OK: false}
	}
	if s.FlushTrace != nil {
		s.FlushTrace()
	}
	trace := s.d.TraceDir
	if trace == "" {
		trace = filepath.Join(s.d.UserData, "gateway", "trace")
	}
	ver := ""
	if s.d.Ports.Version != nil {
		ver = s.d.Ports.Version()
	}
	data, files, err := BuildDiagnosticsBundle(BundleSource{LogDir: s.logDir, TraceDir: trace},
		BundleOptions{Now: now, Meta: []MetaKV{{"version", ver}, {"platform", s.platform()}}})
	if err == nil {
		if werr := os.WriteFile(f, data, 0o600); werr != nil {
			err = errors.New(nodefs.Message(werr, "open", f))
		} else {
			_ = os.Chmod(f, 0o600)
		}
	}
	if err != nil {
		s.warn("diagnostics bundle export failed", "error", err.Error())
		return ExportResult{OK: false, Error: err.Error()}
	}
	if s.d.Logger != nil {
		s.d.Logger.Info("diagnostics bundle exported", "files", len(files))
	}
	return ExportResult{OK: true, Path: f, Files: &files}
}

func (s *Service) warn(m string, kv ...any) {
	if s.d.Logger != nil {
		s.d.Logger.Warn(m, kv...)
	}
}

func (s *Service) Set(on bool) View {
	s.mu.Lock()
	changed := on != s.saveLogs
	s.mu.Unlock()
	if changed {
		before := s.Enabled()
		s.mu.Lock()
		s.saveLogs = on
		s.mu.Unlock()
		b, _ := json.Marshal(struct {
			Version  int  `json:"version"`
			SaveLogs bool `json:"saveLogs"`
		}{1, on})
		if err := utils.WritePrivateFileAtomic(s.file, b); err != nil {
			s.warn("diagnostics settings save failed", "error", err.Error())
		}
		s.apply()
		if s.d.Logger != nil {
			s.d.Logger.Info("diagnostics logs", "saveLogs", on, "enabled", s.Enabled())
		}
		if before != s.Enabled() && s.d.OnChange != nil {
			s.d.OnChange(s.Enabled())
		}
	}
	return s.View()
}

func (s *Service) OpenLogFolder() (bool, error) {
	if err := os.MkdirAll(s.logDir, 0o777); err != nil {
		return false, err
	}
	msg := "no shell"
	if s.d.Ports.OpenPath != nil {
		msg = s.d.Ports.OpenPath(s.logDir)
	}
	if msg != "" {
		return false, errors.New(msg)
	}
	return true, nil
}

func (s *Service) load() bool {
	if _, err := os.Stat(s.file); err != nil {
		legacy := false
		if s.d.LegacyEnabled != nil {
			func() {
				defer func() { _ = recover() }()
				legacy = s.d.LegacyEnabled()
			}()
		}
		if legacy {
			_ = utils.WritePrivateFileAtomic(s.file, []byte(`{"version":1,"saveLogs":true}`))
		}
		return legacy
	}
	b, err := os.ReadFile(s.file)
	if err != nil {
		return false
	}
	var raw any
	if json.Unmarshal(b, &raw) != nil {
		return false
	}
	m, _ := raw.(map[string]any)
	v, _ := m["saveLogs"].(bool)
	return v
}

func (s *Service) apply() {
	if s.d.SetLevel == nil {
		return
	}
	dev := os.Getenv("NODE_ENV") == "development"
	s.d.SetLevel(s.Enabled() || dev)
}

// ReadLegacyGatewayTrace = usage/GatewayRequestLog.readLegacyGatewayTrace（OBSERVE_FILE）
func ReadLegacyGatewayTrace(root string) bool {
	b, err := os.ReadFile(filepath.Join(root, observeFile))
	if err != nil {
		return false
	}
	var raw any
	if json.Unmarshal(b, &raw) != nil {
		return false
	}
	m, _ := raw.(map[string]any)
	v, _ := m["trace"].(bool)
	return v
}
