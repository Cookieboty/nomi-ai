// Package characterassets：当前角色包的远程素材（manifest assets.remote，如官方角色的 .riv）。
// 不随安装包发，切到 Rive 时按远程角色目录（GitHub Release `characters` 的 catalog.json，
// scripts/character/remote-catalog.mjs 生成）下载到 <userData>/character-assets/<packId>/，
// 经 character-pack://assets/<packId>/<file> 给视图。
//
//   - 缓存：<packId>/current.json 记下就绪素材的文件名 / sha256 / 大小；启动时文件在、大小对就直接就绪；
//   - Ensure：读目录，sha256 与缓存一致就不动；不一致（首次 / 新版本）下载到 .part、边下边算 sha256，
//     校验通过才改名并更新 current.json，再删旧文件。更新期间旧素材照常可用；
//   - 失败：有缓存就继续用缓存（只记日志），没有就进入 error，等用户重试（character.ensureAssets）。
//
// 与 Node 版 core/src/character/CharacterAssets.ts 行为一致。见 docs/design/remote-character-assets.md。
package characterassets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const CatalogURL = "https://github.com/Cookieboty/nomi-ai/releases/download/characters/catalog.json"

const (
	catalogTimeout  = 15 * time.Second
	defaultStall    = 60 * time.Second
	maxCatalogBytes = 1 << 20
)

var (
	fileRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	shaRe    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	packIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
)

// State = 契约 CharacterAssetsState
type State struct {
	PackID  *string  `json:"packId"`
	Remote  bool     `json:"remote"`
	Status  string   `json:"status"`
	Version *string  `json:"version,omitempty"`
	Percent *float64 `json:"percent,omitempty"`
	RiveURL *string  `json:"riveUrl,omitempty"`
	Error   *string  `json:"error,omitempty"`
}

// ActivePack：当前角色包里本服务关心的部分（nil = 没有角色包）
type ActivePack struct {
	ID     string
	Rive   string
	Remote []string
}

type Logger interface {
	Info(msg string, kv ...any)
	Warn(msg string, kv ...any)
}

type Options struct {
	// Root：<userData>/character-assets
	Root    string
	Active  func() *ActivePack
	Publish func(State)
	Log     Logger
	Client  *http.Client
	// CatalogURL：空 = CatalogURL
	CatalogURL string
	Stall      time.Duration
}

type Service struct {
	o       Options
	mu      sync.Mutex
	st      State
	running chan struct{}
}

type cached struct {
	File   string `json:"file"`
	Sha256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type asset struct {
	File   string `json:"file"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	Sha256 string `json:"sha256"`
}

func AssetURL(packID, file string) string { return "character-pack://assets/" + packID + "/" + file }

func New(o Options) *Service {
	s := &Service{o: o}
	s.st = s.fromCache()
	return s
}

func strp(v string) *string { return &v }

// State：当前状态（副本）
func (s *Service) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st
}

// Refresh：角色包变了（覆盖包装上 / 卸掉）时按新包重新读缓存
func (s *Service) Refresh() {
	next := s.fromCache()
	s.mu.Lock()
	changed := deref(next.PackID) != deref(s.st.PackID) || next.Remote != s.st.Remote
	s.mu.Unlock()
	if changed {
		s.set(next)
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *Service) remoteRive() (packID, rel string, ok bool) {
	p := s.o.Active()
	if p == nil || p.Rive == "" || !packIDRe.MatchString(p.ID) {
		return "", "", false
	}
	for _, k := range p.Remote {
		if k == "rive" {
			return p.ID, p.Rive, true
		}
	}
	return "", "", false
}

func (s *Service) dir(packID string) string { return filepath.Join(s.o.Root, packID) }

func (s *Service) readCached(packID string) *cached {
	b, err := os.ReadFile(filepath.Join(s.dir(packID), "current.json"))
	if err != nil {
		return nil
	}
	var raw struct {
		Rive *cached `json:"rive"`
	}
	if json.Unmarshal(b, &raw) != nil || raw.Rive == nil {
		return nil
	}
	c := raw.Rive
	if !fileRe.MatchString(c.File) || !shaRe.MatchString(c.Sha256) {
		return nil
	}
	st, err := os.Stat(filepath.Join(s.dir(packID), c.File))
	if err != nil || st.Size() != c.Size {
		return nil
	}
	return c
}

func (s *Service) fromCache() State {
	id, _, ok := s.remoteRive()
	if !ok {
		var pid *string
		if p := s.o.Active(); p != nil {
			pid = strp(p.ID)
		}
		return State{PackID: pid, Remote: false, Status: "idle"}
	}
	if c := s.readCached(id); c != nil {
		return State{PackID: strp(id), Remote: true, Status: "ready", Version: strp(c.Sha256[:12]), RiveURL: strp(AssetURL(id, c.File))}
	}
	return State{PackID: strp(id), Remote: true, Status: "idle"}
}

func (s *Service) set(next State) {
	s.mu.Lock()
	s.st = next
	s.mu.Unlock()
	if s.o.Publish != nil {
		s.o.Publish(next)
	}
}

func (s *Service) patch(f func(*State)) {
	s.mu.Lock()
	f(&s.st)
	next := s.st
	s.mu.Unlock()
	if s.o.Publish != nil {
		s.o.Publish(next)
	}
}

// Ensure：检查目录，缺少或有新版本时下载；并发调用共用一次，返回结束后的状态
func (s *Service) Ensure() State {
	s.mu.Lock()
	if ch := s.running; ch != nil {
		s.mu.Unlock()
		<-ch
		return s.State()
	}
	ch := make(chan struct{})
	s.running = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.running = nil
		s.mu.Unlock()
		close(ch)
	}()
	s.run()
	return s.State()
}

func (s *Service) log(warn bool, msg string, kv ...any) {
	if s.o.Log == nil {
		return
	}
	if warn {
		s.o.Log.Warn(msg, kv...)
	} else {
		s.o.Log.Info(msg, kv...)
	}
}

func (s *Service) run() {
	s.Refresh()
	id, _, ok := s.remoteRive()
	if !ok {
		return
	}
	c := s.readCached(id)
	var ready *State
	if c != nil {
		st := s.fromCache()
		ready = &st
	} else {
		s.patch(func(st *State) { st.Status, st.Error, st.Percent = "checking", nil, nil })
	}
	err := func() error {
		a, err := s.catalogEntry(id)
		if err != nil {
			return err
		}
		if c != nil && c.Sha256 == a.Sha256 {
			return nil
		}
		if err := s.download(id, a, ready != nil); err != nil {
			return err
		}
		s.log(false, "[character-assets] ready", "pack", id, "file", a.File)
		return nil
	}()
	if err == nil {
		s.set(s.fromCache())
		return
	}
	s.log(true, "[character-assets] update failed", "pack", id, "error", err.Error())
	if ready != nil {
		s.set(*ready)
		return
	}
	msg := err.Error()
	s.patch(func(st *State) { st.Status, st.Error, st.Percent = "error", &msg, nil })
}

func (s *Service) client() *http.Client {
	if s.o.Client != nil {
		return s.o.Client
	}
	return &http.Client{}
}

func (s *Service) catalogEntry(packID string) (asset, error) {
	url := s.o.CatalogURL
	if url == "" {
		url = CatalogURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), catalogTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return asset{}, err
	}
	res, err := s.client().Do(req)
	if err != nil {
		return asset{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return asset{}, fmt.Errorf("catalog HttpError: %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxCatalogBytes+1))
	if err != nil {
		return asset{}, err
	}
	if len(b) > maxCatalogBytes {
		return asset{}, errors.New("catalog too large")
	}
	var cat struct {
		SchemaVersion int `json:"schemaVersion"`
		Packs         []struct {
			ID     string `json:"id"`
			Assets struct {
				Rive *asset `json:"rive"`
			} `json:"assets"`
		} `json:"packs"`
	}
	if json.Unmarshal(b, &cat) != nil || cat.SchemaVersion != 1 || cat.Packs == nil {
		return asset{}, errors.New("catalog: unsupported")
	}
	for _, p := range cat.Packs {
		if p.ID != packID {
			continue
		}
		a := p.Assets.Rive
		if a == nil {
			break
		}
		if !fileRe.MatchString(a.File) || a.File == "current.json" || !strings.HasPrefix(a.URL, "https://") ||
			a.Size <= 0 || !shaRe.MatchString(a.Sha256) {
			return asset{}, fmt.Errorf("catalog: invalid rive asset for %s", packID)
		}
		return *a, nil
	}
	return asset{}, fmt.Errorf("catalog: no rive asset for %s", packID)
}

// stallReader：每读到数据就重置计时；超过 stall 没有数据就取消请求
type stallReader struct {
	r     io.Reader
	timer *time.Timer
	stall time.Duration
}

func (s *stallReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if n > 0 {
		s.timer.Reset(s.stall)
	}
	return n, err
}

func (s *Service) download(packID string, a asset, updating bool) (err error) {
	dir := s.dir(packID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	stall := s.o.Stall
	if stall <= 0 {
		stall = defaultStall
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var stalled atomic.Bool
	timer := time.AfterFunc(stall, func() { stalled.Store(true); cancel() })
	defer timer.Stop()
	if !updating {
		s.patch(func(st *State) { st.Status, st.Percent = "downloading", ptrf(0) })
	}
	part := filepath.Join(dir, a.File+".part")
	defer func() {
		if err != nil {
			os.Remove(part)
			if stalled.Load() && !strings.Contains(err.Error(), "sha256") && !strings.Contains(err.Error(), "incomplete") {
				err = fmt.Errorf("download stalled: no data for %ds", int(stall/time.Second))
			}
		}
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return err
	}
	res, err := s.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download HttpError: %d", res.StatusCode)
	}
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	h := sha256.New()
	body := &stallReader{r: res.Body, timer: timer, stall: stall}
	var got int64
	last := -1
	buf := make([]byte, 64<<10)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			got += int64(n)
			if got > a.Size {
				f.Close()
				return errors.New("download larger than the catalog says")
			}
			h.Write(buf[:n])
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				return werr
			}
			if pct := int(got * 100 / a.Size); pct != last && !updating {
				last = pct
				s.patch(func(st *State) { st.Status, st.Percent = "downloading", ptrf(float64(pct)) })
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return rerr
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if got != a.Size {
		return fmt.Errorf("download incomplete (%d/%d bytes)", got, a.Size)
	}
	if hex.EncodeToString(h.Sum(nil)) != a.Sha256 {
		return errors.New("download sha256 mismatch")
	}
	if err := os.Rename(part, filepath.Join(dir, a.File)); err != nil {
		return err
	}
	cur, _ := json.Marshal(map[string]cached{"rive": {File: a.File, Sha256: a.Sha256, Size: a.Size}})
	tmp := filepath.Join(dir, fmt.Sprintf("current.json.%d.tmp", os.Getpid()))
	if err := os.WriteFile(tmp, cur, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, "current.json")); err != nil {
		return err
	}
	// 删掉旧版本（Windows 上旧文件正被读时删不掉，下次再删）
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			if n := e.Name(); n != a.File && n != "current.json" {
				os.Remove(filepath.Join(dir, n))
			}
		}
	}
	return nil
}

func ptrf(v float64) *float64 { return &v }
