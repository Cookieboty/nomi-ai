package sideterminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

const (
	maxID          = 512
	maxTerminals   = 32
	maxWriteBytes  = 65536
	replayBufSize  = 262144
	flushInterval  = 12 * time.Millisecond
	flushChunkSize = 16384
)

// Deps 注入终端管理器所需的项目解析、安全校验、事件推送与 PTY 工厂。
type Deps struct {
	ProjectPrimary     func(projectID string) string
	FindProjectPrimary func(dir string) string
	IsDeniedDir        func(dir string) string
	HomeDir            func() string
	Emit               func(event string, data any)
	StartPTY           func(StartOptions) (PTY, error)
}

// OpenInput 对应契约 sideTerminal.open 的入参。
type OpenInput struct {
	ID          string `json:"id"`
	ProjectID   string `json:"projectId,omitempty"`
	Cwd         string `json:"cwd,omitempty"`
	ExplicitCwd bool   `json:"explicitCwd,omitempty"`
	Cols        int    `json:"cols,omitempty"`
	Rows        int    `json:"rows,omitempty"`
}

// OpenResult 对应契约 sideTerminal.open 的返回结果。
type OpenResult struct {
	OK       bool    `json:"ok"`
	Cwd      string  `json:"cwd,omitempty"`
	Shell    string  `json:"shell,omitempty"`
	Replay   string  `json:"replay,omitempty"`
	Exited   bool    `json:"exited,omitempty"`
	ExitCode *int    `json:"exitCode,omitempty"`
	Reason   *string `json:"reason,omitempty"`
	Message  *string `json:"message,omitempty"`
}

// Manager 管理所有活跃的侧边内置终端会话及其生命周期。
type Manager struct {
	deps Deps

	mu       sync.Mutex
	sessions map[string]*session

	watchMu sync.Mutex
	watched map[int]bool
}

type session struct {
	id     string
	cwd    string
	shell  string
	pty    PTY
	owner  int
	closed bool

	outMu    sync.Mutex
	replay   *ringBuffer
	exited   bool
	exitCode *int

	readDone chan struct{}
}

type ringBuffer struct {
	cap int
	buf []byte
}

func newRingBuffer(capacity int) *ringBuffer {
	return &ringBuffer{cap: capacity}
}

func (r *ringBuffer) write(p []byte) {
	if len(p) == 0 || r.cap <= 0 {
		return
	}
	if len(p) >= r.cap {
		r.buf = append(r.buf[:0], p[len(p)-r.cap:]...)
		return
	}
	overflow := len(r.buf) + len(p) - r.cap
	if overflow > 0 {
		copy(r.buf, r.buf[overflow:])
		r.buf = r.buf[:len(r.buf)-overflow]
	}
	r.buf = append(r.buf, p...)
}

func (r *ringBuffer) snapshot() []byte {
	if len(r.buf) == 0 {
		return nil
	}
	cp := make([]byte, len(r.buf))
	copy(cp, r.buf)
	return cp
}

// New 创建内置终端管理器。
func New(deps Deps) *Manager {
	if deps.StartPTY == nil {
		deps.StartPTY = startPTY
	}
	if deps.HomeDir == nil {
		deps.HomeDir = func() string {
			h, _ := os.UserHomeDir()
			return h
		}
	}
	return &Manager{
		deps:     deps,
		sessions: map[string]*session{},
		watched:  map[int]bool{},
	}
}

func openErr(reason, message string) OpenResult {
	r := reason
	res := OpenResult{OK: false, Reason: &r}
	if message != "" {
		m := message
		if len(m) > 500 {
			m = m[:500]
		}
		res.Message = &m
	}
	return res
}

func bad(msg string) error {
	return &contract.Error{Code: "BAD_INPUT", Message: msg}
}

func isExistingDir(dir string) bool {
	if dir == "" || !filepath.IsAbs(dir) {
		return false
	}
	st, err := os.Stat(dir)
	return err == nil && st.IsDir()
}

func (m *Manager) isAllowed(dir string) string {
	if dir == "" {
		return "empty directory"
	}
	if m.deps.IsDeniedDir != nil {
		return m.deps.IsDeniedDir(dir)
	}
	return ""
}

// resolveDir 按产品约定定位终端工作目录：
// 1. explicitCwd=true 时严格使用 requestedCwd 并校验受保护目录；
// 2. 否则依次优先：projectId 对应主工程 Primary → requestedCwd 反查项目 Primary → requestedCwd → 用户主目录 → 当前进程目录。
func (m *Manager) resolveDir(projectID, requestedCwd string, explicitCwd bool) (dir, reason, message string) {
	requested := strings.TrimSpace(requestedCwd)
	if explicitCwd && requested != "" {
		cleaned := filepath.Clean(requested)
		if !isExistingDir(cleaned) {
			return "", "failed", "invalid working directory"
		}
		if denied := m.isAllowed(cleaned); denied != "" {
			return "", "denied", denied
		}
		return cleaned, "", ""
	}

	if projectID != "" && m.deps.ProjectPrimary != nil {
		if prim := strings.TrimSpace(m.deps.ProjectPrimary(projectID)); prim != "" {
			cleaned := filepath.Clean(prim)
			if isExistingDir(cleaned) && m.isAllowed(cleaned) == "" {
				return cleaned, "", ""
			}
		}
	}

	if requested != "" {
		cleanedReq := filepath.Clean(requested)
		if m.deps.FindProjectPrimary != nil {
			if prim := strings.TrimSpace(m.deps.FindProjectPrimary(cleanedReq)); prim != "" {
				cleanedPrim := filepath.Clean(prim)
				if isExistingDir(cleanedPrim) && m.isAllowed(cleanedPrim) == "" {
					return cleanedPrim, "", ""
				}
			}
		}
		if isExistingDir(cleanedReq) && m.isAllowed(cleanedReq) == "" {
			return cleanedReq, "", ""
		}
	}

	if m.deps.HomeDir != nil {
		if home := strings.TrimSpace(m.deps.HomeDir()); home != "" {
			cleanedHome := filepath.Clean(home)
			if isExistingDir(cleanedHome) && m.isAllowed(cleanedHome) == "" {
				return cleanedHome, "", ""
			}
		}
	}

	if wd, err := os.Getwd(); err == nil && isExistingDir(wd) && m.isAllowed(wd) == "" {
		return wd, "", ""
	}
	return "", "failed", "no valid working directory available"
}

// Open 打开（或复用）一个终端会话。
func (m *Manager) Open(in OpenInput) OpenResult {
	return m.OpenOwned(in, 0)
}

// OpenOwned 打开（或复用）归属指定连接 owner 的终端会话；若已存在则重绑 owner 并回放近期输出。
func (m *Manager) OpenOwned(in OpenInput, owner int) OpenResult {
	if in.ID == "" || len(in.ID) > maxID {
		return openErr("failed", "invalid terminal id")
	}

	m.mu.Lock()
	existing := m.sessions[in.ID]
	if existing != nil {
		if owner > 0 {
			existing.owner = owner
		}
		m.mu.Unlock()

		if in.Cols > 0 && in.Rows > 0 {
			c, r := clampSize(in.Cols, in.Rows)
			_ = existing.pty.Resize(c, r)
		}
		existing.outMu.Lock()
		replayBytes := existing.replay.snapshot()
		exited := existing.exited
		exitCode := existing.exitCode
		existing.outMu.Unlock()

		var replayB64 string
		if len(replayBytes) > 0 {
			replayB64 = base64.StdEncoding.EncodeToString(replayBytes)
		}
		return OpenResult{
			OK:       true,
			Cwd:      existing.cwd,
			Shell:    existing.shell,
			Replay:   replayB64,
			Exited:   exited,
			ExitCode: exitCode,
		}
	}

	if len(m.sessions) >= maxTerminals {
		m.mu.Unlock()
		return openErr("limit", "too many terminals")
	}
	m.mu.Unlock()

	dir, reason, msg := m.resolveDir(in.ProjectID, in.Cwd, in.ExplicitCwd)
	if reason != "" {
		return openErr(reason, msg)
	}

	cols, rows := clampSize(in.Cols, in.Rows)
	p, err := m.deps.StartPTY(StartOptions{
		Dir:  dir,
		Cols: cols,
		Rows: rows,
	})
	if err != nil {
		if errors.Is(err, ErrUnsupported) {
			return openErr("unsupported", err.Error())
		}
		return openErr("failed", err.Error())
	}

	sess := &session{
		id:       in.ID,
		cwd:      dir,
		shell:    p.Shell(),
		pty:      p,
		owner:    owner,
		replay:   newRingBuffer(replayBufSize),
		readDone: make(chan struct{}),
	}

	m.mu.Lock()
	// 并发打开同一个 id 时的二次检查：若已有胜出者，关掉后启动的这一份并复用已存在的。
	if winner := m.sessions[in.ID]; winner != nil {
		if owner > 0 {
			winner.owner = owner
		}
		m.mu.Unlock()
		_ = p.Close()

		winner.outMu.Lock()
		replayBytes := winner.replay.snapshot()
		exited := winner.exited
		exitCode := winner.exitCode
		winner.outMu.Unlock()
		var replayB64 string
		if len(replayBytes) > 0 {
			replayB64 = base64.StdEncoding.EncodeToString(replayBytes)
		}
		return OpenResult{
			OK:       true,
			Cwd:      winner.cwd,
			Shell:    winner.shell,
			Replay:   replayB64,
			Exited:   exited,
			ExitCode: exitCode,
		}
	}
	if len(m.sessions) >= maxTerminals {
		m.mu.Unlock()
		_ = p.Close()
		return openErr("limit", "too many terminals")
	}
	m.sessions[in.ID] = sess
	m.mu.Unlock()

	go m.pumpOutput(sess)
	go m.waitExit(sess)

	return OpenResult{
		OK:    true,
		Cwd:   sess.cwd,
		Shell: sess.shell,
	}
}

func (m *Manager) pumpOutput(sess *session) {
	defer close(sess.readDone)

	chunks := make(chan []byte, 32)
	go func() {
		defer close(chunks)
		buf := make([]byte, 8192)
		for {
			n, err := sess.pty.Read(buf)
			if n > 0 {
				cp := make([]byte, n)
				copy(cp, buf[:n])
				chunks <- cp
			}
			if err != nil {
				return
			}
		}
	}()

	var pending []byte
	timer := time.NewTimer(flushInterval)
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	defer timer.Stop()
	timerRunning := false

	flush := func() {
		if len(pending) == 0 {
			return
		}
		data := pending
		pending = nil

		sess.outMu.Lock()
		sess.replay.write(data)
		sess.outMu.Unlock()

		m.mu.Lock()
		closed := sess.closed
		m.mu.Unlock()
		if !closed && m.deps.Emit != nil {
			m.deps.Emit("sideTerminal.data", map[string]any{
				"id":   sess.id,
				"data": base64.StdEncoding.EncodeToString(data),
			})
		}
	}

	for {
		select {
		case chunk, ok := <-chunks:
			if !ok {
				flush()
				return
			}
			pending = append(pending, chunk...)
			if len(pending) >= flushChunkSize {
				if timerRunning && !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timerRunning = false
				flush()
			} else if !timerRunning {
				timer.Reset(flushInterval)
				timerRunning = true
			}
		case <-timer.C:
			timerRunning = false
			flush()
		}
	}
}

func (m *Manager) waitExit(sess *session) {
	code, sig, err := sess.pty.Wait()
	select {
	case <-sess.readDone:
	case <-time.After(500 * time.Millisecond):
	}

	m.mu.Lock()
	closed := sess.closed
	stillTracked := m.sessions[sess.id] == sess
	m.mu.Unlock()

	sess.outMu.Lock()
	sess.exited = true
	if sig == "" {
		c := code
		sess.exitCode = &c
	}
	sess.outMu.Unlock()

	if closed || !stillTracked || m.deps.Emit == nil {
		return
	}

	payload := map[string]any{"id": sess.id}
	if sig != "" {
		payload["signal"] = sig
	} else {
		payload["exitCode"] = code
	}
	if err != nil {
		msg := err.Error()
		if len(msg) > 500 {
			msg = msg[:500]
		}
		payload["message"] = msg
	}
	m.deps.Emit("sideTerminal.exit", payload)
}

// Write 向指定终端写入数据。
func (m *Manager) Write(id, data string) bool {
	if id == "" || len(id) > maxID || data == "" || len(data) > maxWriteBytes {
		return false
	}
	m.mu.Lock()
	sess := m.sessions[id]
	closed := sess == nil || sess.closed
	m.mu.Unlock()
	if closed {
		return false
	}
	_, err := sess.pty.Write([]byte(data))
	return err == nil
}

// Resize 同步指定终端的行列尺寸。
func (m *Manager) Resize(id string, cols, rows int) bool {
	if id == "" || len(id) > maxID {
		return false
	}
	m.mu.Lock()
	sess := m.sessions[id]
	closed := sess == nil || sess.closed
	m.mu.Unlock()
	if closed {
		return false
	}
	c, r := clampSize(cols, rows)
	return sess.pty.Resize(c, r) == nil
}

// Close 关闭并移除指定终端会话。
func (m *Manager) Close(id string) bool {
	if id == "" || len(id) > maxID {
		return false
	}
	m.mu.Lock()
	sess := m.sessions[id]
	if sess != nil {
		sess.closed = true
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if sess == nil {
		return false
	}
	_ = sess.pty.Close()
	return true
}

// Sync 对账 owner 名下存活的终端 id，清理不在此清单中的孤儿进程。
func (m *Manager) Sync(owner int, ids []string) []string {
	want := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id != "" && len(id) <= maxID {
			want[id] = struct{}{}
		}
	}
	m.mu.Lock()
	var gone []*session
	for id, sess := range m.sessions {
		if _, keep := want[id]; keep {
			continue
		}
		if owner > 0 && sess.owner != owner {
			continue
		}
		sess.closed = true
		delete(m.sessions, id)
		gone = append(gone, sess)
	}
	m.mu.Unlock()

	closedIDs := make([]string, 0, len(gone))
	for _, sess := range gone {
		_ = sess.pty.Close()
		closedIDs = append(closedIDs, sess.id)
	}
	return closedIDs
}

// CloseOwner 收掉 owner 名下的全部终端进程；owner <= 0 表示收掉全部。
func (m *Manager) CloseOwner(owner int) {
	if owner <= 0 {
		m.CloseAll()
		return
	}
	m.Sync(owner, nil)
}

// CloseAll 关闭并回收所有活跃终端进程（应用退出或整页重载兜底）。
func (m *Manager) CloseAll() {
	m.mu.Lock()
	all := make([]*session, 0, len(m.sessions))
	for _, sess := range m.sessions {
		sess.closed = true
		all = append(all, sess)
	}
	m.sessions = map[string]*session{}
	m.mu.Unlock()
	for _, sess := range all {
		_ = sess.pty.Close()
	}
}

func (m *Manager) watch(c contract.Caller) {
	if c.Done == nil || c.ID <= 0 {
		return
	}
	m.watchMu.Lock()
	if m.watched[c.ID] {
		m.watchMu.Unlock()
		return
	}
	m.watched[c.ID] = true
	m.watchMu.Unlock()
	go func() {
		<-c.Done
		m.watchMu.Lock()
		delete(m.watched, c.ID)
		m.watchMu.Unlock()
		m.CloseOwner(c.ID)
	}()
}

// Register 把 sideTerminal.* 契约过程挂到 Router。
func Register(r *contract.Router, m *Manager) {
	r.Call("sideTerminal.open", func(_ context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
		var in OpenInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		m.watch(c)
		return m.OpenOwned(in, c.ID), nil
	})
	r.Call("sideTerminal.write", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID   string `json:"id"`
			Data string `json:"data"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.Write(in.ID, in.Data), nil
	})
	r.Call("sideTerminal.resize", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID   string `json:"id"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.Resize(in.ID, in.Cols, in.Rows), nil
	})
	r.Call("sideTerminal.close", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.Close(in.ID), nil
	})
	r.Call("sideTerminal.closeAll", func(_ context.Context, c contract.Caller, _ json.RawMessage) (any, error) {
		m.watch(c)
		m.CloseOwner(c.ID)
		return true, nil
	})
	r.Call("sideTerminal.sync", func(_ context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			IDs []string `json:"ids"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		m.watch(c)
		closed := m.Sync(c.ID, in.IDs)
		if closed == nil {
			closed = []string{}
		}
		return map[string]any{"closed": closed}, nil
	})
}
