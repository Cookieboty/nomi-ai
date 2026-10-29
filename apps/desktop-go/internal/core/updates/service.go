// Package updates = packages/core/src/services/UpdateService.ts：检查 / 下载状态、重试、卡住检测、自动检查开关。
// 真正的更新器（= electron-updater 的 autoUpdater）由组合根注入（Updater）；Go 版的实现见 github.go（latest-go.json）。
package updates

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodefs"
)

// Opt 是 TS 里「可缺省、可为 null」的字符串字段（releaseName / releaseNotes）
type Opt struct {
	Set bool
	V   *string
}

func OptStr(s string) Opt { return Opt{Set: true, V: &s} }

var OptNull = Opt{Set: true}

type State struct {
	Status           string
	CurrentVersion   string
	AvailableVersion *string
	ReleaseName      Opt
	ReleaseNotes     Opt
	Percent          *float64
	BytesPerSecond   *float64
	Transferred      *float64
	Total            *float64
	Error            *string
	ErrorStage       *string
	CheckedAt        *int64
	AutoCheck        bool
	ReleasePending   *bool
}

func (s State) MarshalJSON() ([]byte, error) {
	m := map[string]any{"status": s.Status, "currentVersion": s.CurrentVersion, "autoCheck": s.AutoCheck}
	put := func(k string, v any, ok bool) {
		if ok {
			m[k] = v
		}
	}
	put("availableVersion", deref(s.AvailableVersion), s.AvailableVersion != nil)
	put("releaseName", deref(s.ReleaseName.V), s.ReleaseName.Set)
	put("releaseNotes", deref(s.ReleaseNotes.V), s.ReleaseNotes.Set)
	for k, p := range map[string]*float64{"percent": s.Percent, "bytesPerSecond": s.BytesPerSecond, "transferred": s.Transferred, "total": s.Total} {
		if p != nil {
			m[k] = num(p)
		}
	}
	put("error", deref(s.Error), s.Error != nil)
	put("errorStage", deref(s.ErrorStage), s.ErrorStage != nil)
	if s.CheckedAt != nil {
		m["checkedAt"] = *s.CheckedAt
	}
	if s.ReleasePending != nil {
		m["releasePending"] = *s.ReleasePending
	}
	return json.Marshal(m)
}

func deref(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// JSON.stringify：NaN / ±Infinity → null
func num(p *float64) any {
	if math.IsNaN(*p) || math.IsInf(*p, 0) {
		return nil
	}
	return *p
}

// UpdateInfo / ProgressInfo = electron-updater 的同名结构里用到的字段
type UpdateInfo struct {
	Version      string
	ReleaseName  Opt
	ReleaseNotes any // 只有 string 才会进状态
}

type ProgressInfo struct{ Percent, BytesPerSecond, Transferred, Total float64 }

// CheckResult = checkForUpdates() 的返回（nil = null）
type CheckResult struct {
	Info UpdateInfo
	// Cancel = cancellationToken.cancel（nil = 没有）
	Cancel func()
}

// UpdaterEvents：更新器回调（= autoUpdater.on(...)）
type UpdaterEvents struct {
	CheckingForUpdate  func()
	UpdateAvailable    func(UpdateInfo)
	UpdateNotAvailable func()
	DownloadProgress   func(ProgressInfo)
	UpdateDownloaded   func(UpdateInfo)
	Error              func(error)
}

// Updater = UpdaterLike
type Updater interface {
	Configure(autoDownload, autoInstallOnAppQuit, allowPrerelease bool, log Logger)
	On(UpdaterEvents)
	RemoveAllListeners()
	CheckForUpdates() (*CheckResult, error)
	DownloadUpdate() error
	QuitAndInstall(isSilent, isForceRunAfter bool) error
}

// CodedError：带 code 的错误（= electron-updater 的 newError(msg, code)）
type CodedError struct{ Code, Msg string }

func (e *CodedError) Error() string { return e.Msg }

var missingMeta = regexp.MustCompile(`(?i)Cannot find [\w.-]+\.yml in the latest release artifacts`)

// IsMissingUpdateMetadata = isMissingUpdateMetadata
func IsMissingUpdateMetadata(err error) bool {
	if ce, ok := err.(*CodedError); ok && ce.Code == "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" {
		return true
	}
	return err != nil && missingMeta.MatchString(err.Error())
}

type Logger interface {
	Info(msg string, kv ...any)
	Warn(msg string, kv ...any)
	Error(msg string, kv ...any)
	Debug(msg string, kv ...any)
}

// Timer / Clock：setTimeout / setInterval / Date.now（测试注入假时钟）
type Timer interface{ Stop() }

type Clock interface {
	Now() int64
	AfterFunc(ms int64, f func()) Timer
	Every(ms int64, f func()) Timer
}

type realClock struct{}

func (realClock) Now() int64 { return time.Now().UnixMilli() }
func (realClock) AfterFunc(ms int64, f func()) Timer {
	return stdTimer{time.AfterFunc(time.Duration(ms)*time.Millisecond, f)}
}

type stdTimer struct{ t *time.Timer }

func (t stdTimer) Stop() { t.t.Stop() }

type ticker struct{ stop chan struct{} }

func (t *ticker) Stop() {
	select {
	case <-t.stop:
	default:
		close(t.stop)
	}
}

func (realClock) Every(ms int64, f func()) Timer {
	t := &ticker{stop: make(chan struct{})}
	tk := time.NewTicker(time.Duration(ms) * time.Millisecond)
	go func() {
		defer tk.Stop()
		for {
			select {
			case <-t.stop:
				return
			case <-tk.C:
				f()
			}
		}
	}()
	return t
}

const (
	DefaultLaunchDelay = 15_000
	DefaultStallMs     = 90_000
	DefaultInterval    = 6 * 60 * 60 * 1000
)

type Options struct {
	Version  func() string
	Packaged bool
	Publish  func(event string, payload any)
	Updater  Updater
	// LaunchDelayMs / IntervalMs / StallMs：nil 用默认值
	LaunchDelayMs, IntervalMs, StallMs *int64
	// SettingsFile：nil = <userData>/update-settings.json；指向 "" = 不落盘
	SettingsFile *string
	UserData     string
	Clock        Clock
	// Persisted：异步落盘完成回调（测试用）
	Persisted func()
}

type Service struct {
	mu            sync.Mutex
	log           Logger
	o             Options
	updater       Updater
	packaged      bool
	launchDelayMs int64
	intervalMs    int64
	stallMs       int64
	autoCheck     bool
	settingsFile  string
	state         State
	launchTimer   Timer
	intervalTimer Timer
	stallTimer    Timer
	started       bool
	downloadToken func()
	hasToken      bool
	writes        sync.WaitGroup
}

// WaitPersisted：等异步落盘结束（测试 / 退出前用）
func (s *Service) WaitPersisted() { s.writes.Wait() }

func or(p *int64, d int64) int64 {
	if p == nil {
		return d
	}
	return *p
}

// loadAutoCheck：只有显式存下的 false 才关
func loadAutoCheck(file string) bool {
	if file == "" {
		return true
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return true
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		return true
	}
	if m, ok := v.(map[string]any); ok {
		return m["autoCheck"] != false
	}
	return true
}

func New(log Logger, o Options) *Service {
	if o.Clock == nil {
		o.Clock = realClock{}
	}
	s := &Service{log: log, o: o, updater: o.Updater, packaged: o.Packaged,
		launchDelayMs: or(o.LaunchDelayMs, DefaultLaunchDelay),
		intervalMs:    or(o.IntervalMs, DefaultInterval),
		stallMs:       or(o.StallMs, DefaultStallMs),
	}
	if o.SettingsFile == nil {
		s.settingsFile = filepath.Join(o.UserData, "update-settings.json")
	} else {
		s.settingsFile = *o.SettingsFile
	}
	s.autoCheck = loadAutoCheck(s.settingsFile)
	st := "unavailable"
	if s.packaged {
		st = "idle"
	}
	s.state = State{Status: st, CurrentVersion: o.Version(), AutoCheck: s.autoCheck}
	return s
}

func (s *Service) GetState() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

type prefixLog struct{ l Logger }

func (p prefixLog) Info(m string, kv ...any)  { p.l.Info("[updater] "+m, kv...) }
func (p prefixLog) Warn(m string, kv ...any)  { p.l.Warn("[updater] "+m, kv...) }
func (p prefixLog) Error(m string, kv ...any) { p.l.Error("[updater] "+m, kv...) }
func (p prefixLog) Debug(m string, kv ...any) { p.l.Debug("[updater] "+m, kv...) }

func ptr[T any](v T) *T { return &v }

// Start：接更新器事件，排启动检查与定时检查；只生效一次
func (s *Service) Start() {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.mu.Unlock()
	s.updater.Configure(true, false, false, prefixLog{s.log})
	s.updater.On(UpdaterEvents{
		CheckingForUpdate: func() { s.patch(func(st *State) { st.Status = "checking" }) },
		UpdateAvailable: func(i UpdateInfo) {
			now := s.o.Clock.Now()
			s.patch(func(st *State) {
				st.ReleasePending = nil
				st.Status = "available"
				st.AvailableVersion = ptr(i.Version)
				st.ReleaseName = i.ReleaseName
				if n, ok := i.ReleaseNotes.(string); ok {
					st.ReleaseNotes = OptStr(n)
				} else {
					st.ReleaseNotes = OptNull
				}
				st.CheckedAt = &now
				st.Error = nil
			})
		},
		UpdateNotAvailable: func() {
			now := s.o.Clock.Now()
			s.patch(func(st *State) {
				st.ReleasePending = nil
				st.Status = "not-available"
				st.AvailableVersion = nil
				st.CheckedAt = &now
				st.Error = nil
			})
		},
		DownloadProgress: func(p ProgressInfo) {
			s.patch(func(st *State) {
				st.Status = "downloading"
				st.Percent, st.BytesPerSecond, st.Transferred, st.Total = ptr(p.Percent), ptr(p.BytesPerSecond), ptr(p.Transferred), ptr(p.Total)
			})
		},
		UpdateDownloaded: func(i UpdateInfo) {
			s.patch(func(st *State) {
				st.Status = "downloaded"
				st.AvailableVersion = ptr(i.Version)
				st.ReleaseName = i.ReleaseName
				st.Percent = ptr(100.0)
				st.Error = nil
			})
		},
		Error: func(err error) {
			msg := err.Error()
			s.log.Warn("[updater] error", "error", msg)
			if s.GetState().Status == "checking" && IsMissingUpdateMetadata(err) {
				s.releasePending()
			} else {
				s.fail(msg, "")
			}
		},
	})
	if !s.packaged {
		s.log.Info("[updater] skipped (unpackaged / dev build)")
		return
	}
	s.mu.Lock()
	if s.launchDelayMs > 0 {
		s.launchTimer = s.o.Clock.AfterFunc(s.launchDelayMs, func() {
			s.mu.Lock()
			on := s.autoCheck
			s.mu.Unlock()
			if on {
				s.Check()
			}
		})
	}
	s.rescheduleIntervalLocked()
	s.mu.Unlock()
}

func (s *Service) Stop() {
	s.mu.Lock()
	s.clearStallLocked()
	for _, t := range []*Timer{&s.launchTimer, &s.intervalTimer} {
		if *t != nil {
			(*t).Stop()
		}
		*t = nil
	}
	s.started = false
	s.mu.Unlock()
	s.updater.RemoveAllListeners()
}

func (s *Service) SetAutoCheck(on bool) {
	s.mu.Lock()
	s.autoCheck = on
	s.persistAutoCheckLocked()
	s.mu.Unlock()
	s.patch(func(st *State) { st.AutoCheck = on })
	s.mu.Lock()
	s.rescheduleIntervalLocked()
	s.mu.Unlock()
}

func (s *Service) persistAutoCheckLocked() {
	if s.settingsFile == "" {
		return
	}
	data := fmt.Sprintf(`{"version":1,"autoCheck":%t}`, s.autoCheck)
	file := s.settingsFile
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		s.log.Warn("[updater] failed to persist autoCheck", "error", "Error: "+nodefs.Message(err, "mkdir", filepath.Dir(file)))
		return
	}
	// 异步落盘（= writePrivateFileAtomicAsync）
	s.writes.Add(1)
	go func() {
		defer s.writes.Done()
		if err := utils.WritePrivateFileAtomic(file, []byte(data)); err != nil {
			s.log.Warn("[updater] failed to persist autoCheck", "error", "Error: "+nodefs.Message(err, "rename", file))
		}
	}()
}

func (s *Service) Check() State {
	if !s.packaged {
		now := s.o.Clock.Now()
		s.patch(func(st *State) {
			st.Status = "unavailable"
			st.Error = ptr("updates only apply to installed builds")
			st.CheckedAt = &now
		})
		return s.GetState()
	}
	s.cancelDownload()
	s.patch(func(st *State) {
		st.Status = "checking"
		st.Error, st.ErrorStage, st.ReleasePending = nil, nil, nil
	})
	r, err := s.updater.CheckForUpdates()
	if err == nil {
		s.mu.Lock()
		if r != nil && r.Cancel != nil {
			s.downloadToken, s.hasToken = r.Cancel, true
		} else {
			s.downloadToken, s.hasToken = nil, false
		}
		s.mu.Unlock()
	} else if IsMissingUpdateMetadata(err) {
		s.releasePending()
	} else {
		s.fail(err.Error(), "check")
		now := s.o.Clock.Now()
		s.patch(func(st *State) { st.CheckedAt = &now })
	}
	return s.GetState()
}

func (s *Service) releasePending() {
	s.mu.Lock()
	s.downloadToken, s.hasToken = nil, false
	s.mu.Unlock()
	now := s.o.Clock.Now()
	s.patch(func(st *State) {
		st.Status = "not-available"
		st.AvailableVersion = nil
		st.ReleasePending = ptr(true)
		st.Error, st.ErrorStage = nil, nil
		st.CheckedAt = &now
	})
}

func (s *Service) Download() State {
	if !s.packaged {
		return s.GetState()
	}
	if err := s.updater.DownloadUpdate(); err != nil {
		s.fail(err.Error(), "download")
	}
	return s.GetState()
}

// Install：用户确认后退出并安装已下载的更新
func (s *Service) Install() State {
	if s.GetState().Status != "downloaded" {
		return s.GetState()
	}
	s.log.Info("[updater] quitAndInstall")
	if err := s.updater.QuitAndInstall(false, true); err != nil {
		s.fail(err.Error(), "install")
	}
	return s.GetState()
}

func (s *Service) fail(msg, stage string) {
	s.mu.Lock()
	prev := s.state.Status
	s.downloadToken, s.hasToken = nil, false
	s.mu.Unlock()
	if stage == "" {
		switch prev {
		case "downloading", "available":
			stage = "download"
		case "downloaded":
			stage = "install"
		default:
			stage = "check"
		}
	}
	s.patch(func(st *State) { st.Status = "error"; st.Error = ptr(msg); st.ErrorStage = ptr(stage) })
}

func (s *Service) cancelDownload() {
	s.mu.Lock()
	tok, has := s.downloadToken, s.hasToken
	s.downloadToken, s.hasToken = nil, false
	s.mu.Unlock()
	if has && tok != nil {
		func() {
			defer func() { recover() }()
			tok()
		}()
	}
}

func (s *Service) clearStallLocked() {
	if s.stallTimer != nil {
		s.stallTimer.Stop()
	}
	s.stallTimer = nil
}

func active(st string) bool { return st == "downloading" || st == "available" || st == "checking" }

func (s *Service) watchStallLocked() {
	s.clearStallLocked()
	if s.stallMs <= 0 || !active(s.state.Status) {
		return
	}
	var t Timer
	t = s.o.Clock.AfterFunc(s.stallMs, func() {
		s.mu.Lock()
		if s.stallTimer != t {
			s.mu.Unlock()
			return
		}
		s.stallTimer = nil
		st := s.state.Status
		s.mu.Unlock()
		if !active(st) {
			return
		}
		secs := int64(math.Floor(float64(s.stallMs)/1000 + 0.5))
		checking := st == "checking"
		if checking {
			s.log.Warn("[updater] check stalled", "secs", secs)
		} else {
			s.log.Warn("[updater] download stalled", "secs", secs)
		}
		s.cancelDownload()
		if checking {
			s.fail(fmt.Sprintf("update check stalled: no response for %ds", secs), "check")
		} else {
			s.fail(fmt.Sprintf("download stalled: no progress for %ds", secs), "download")
		}
	})
	s.stallTimer = t
}

func (s *Service) rescheduleIntervalLocked() {
	if s.intervalTimer != nil {
		s.intervalTimer.Stop()
	}
	s.intervalTimer = nil
	if !s.packaged || !s.autoCheck || s.intervalMs <= 0 {
		return
	}
	s.intervalTimer = s.o.Clock.Every(s.intervalMs, func() {
		s.mu.Lock()
		on := s.autoCheck
		s.mu.Unlock()
		if on {
			s.Check()
		}
	})
}

func (s *Service) patch(f func(*State)) {
	s.mu.Lock()
	f(&s.state)
	s.state.CurrentVersion = s.o.Version()
	s.state.AutoCheck = s.autoCheck
	if s.state.Status != "error" {
		s.state.ErrorStage = nil
	}
	s.watchStallLocked()
	st := s.state
	s.mu.Unlock()
	if s.o.Publish != nil {
		s.o.Publish("updates.changed", st)
	}
}
