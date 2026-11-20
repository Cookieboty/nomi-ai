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
	Replace     bool   `json:"replace,omitempty"`
}

// OpenResult 对应契约 sideTerminal.open 的返回结果。
type OpenResult struct {
	OK           bool    `json:"ok"`
	Cwd          string  `json:"cwd,omitempty"`
	Shell        string  `json:"shell,omitempty"`
	Replay       string  `json:"replay,omitempty"`
	Generation   int64   `json:"generation,omitempty"`
	ReplayOffset *int64  `json:"replayOffset,omitempty"`
	Exited       bool    `json:"exited,omitempty"`
	ExitCode     *int    `json:"exitCode,omitempty"`
	Reason       *string `json:"reason,omitempty"`
	Message      *string `json:"message,omitempty"`
}

// Manager 管理所有活跃的侧边内置终端会话及其生命周期。
type Manager struct {
	deps Deps

	mu      sync.Mutex
	nextGen int64
	slots   map[string]*termSlot

	watchMu sync.Mutex
	watched map[int]bool
}

type termSlot struct {
	current  *session
	starting *pendingStart
}

type pendingStart struct {
	gen      int64
	owner    int
	canceled bool
	doneOnce sync.Once
	done     chan struct{}
}

func (p *pendingStart) finish() {
	p.doneOnce.Do(func() {
		close(p.done)
	})
}

type session struct {
	id         string
	generation int64
	cwd        string
	shell      string
	pty        PTY
	owner      int
	closed     bool
	closeOnce  sync.Once

	outMu    sync.Mutex
	replay   *ringBuffer
	exited   bool
	exitCode *int

	readDone chan struct{}
}

func (s *session) closePTY() {
	if s == nil {
		return
	}
	s.closeOnce.Do(func() {
		_ = s.pty.Close()
	})
}

type ringBuffer struct {
	cap        int
	buf        []byte
	totalBytes int64
	truncated  bool
}

func newRingBuffer(capacity int) *ringBuffer {
	return &ringBuffer{cap: capacity}
}

func (r *ringBuffer) write(p []byte) {
	if len(p) == 0 || r.cap <= 0 {
		return
	}
	r.totalBytes += int64(len(p))
	if len(p) >= r.cap {
		if len(p) > r.cap || len(r.buf) > 0 {
			r.truncated = true
		}
		r.buf = append(r.buf[:0], p[len(p)-r.cap:]...)
		return
	}
	overflow := len(r.buf) + len(p) - r.cap
	if overflow > 0 {
		r.truncated = true
		copy(r.buf, r.buf[overflow:])
		r.buf = r.buf[:len(r.buf)-overflow]
	}
	r.buf = append(r.buf, p...)
}

func (r *ringBuffer) snapshot() ([]byte, int64) {
	if len(r.buf) == 0 {
		return nil, r.totalBytes
	}
	start := 0
	// 环形缓冲发生头部截断时，最多跳过开头的 3 个孤立 UTF-8 续字节（10xxxxxx），避免首字符乱码；
	// 末尾累计字节偏移 totalBytes 保持不变，保证后续实时流按偏移严格衔接。
	if r.truncated {
		for start < len(r.buf) && start < 3 && (r.buf[start]&0xc0) == 0x80 {
			start++
		}
	}
	cp := make([]byte, len(r.buf)-start)
	copy(cp, r.buf[start:])
	return cp, r.totalBytes
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
		deps:    deps,
		slots:   map[string]*termSlot{},
		watched: map[int]bool{},
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

func int64Ptr(v int64) *int64 { return &v }

func (m *Manager) slotLocked(id string) *termSlot {
	slot := m.slots[id]
	if slot == nil {
		slot = &termSlot{}
		m.slots[id] = slot
	}
	return slot
}

func (m *Manager) pruneSlotLocked(id string, slot *termSlot) {
	if slot != nil && slot.current == nil && slot.starting == nil {
		delete(m.slots, id)
	}
}

func (m *Manager) activeCountLocked() int {
	n := 0
	for _, slot := range m.slots {
		if slot.current != nil || (slot.starting != nil && !slot.starting.canceled) {
			n++
		}
	}
	return n
}

func (m *Manager) reuseSessionResult(sess *session, cols, rows int) (OpenResult, bool) {
	if cols > 0 && rows > 0 {
		c, r := clampSize(cols, rows)
		_ = sess.pty.Resize(c, r)
	}
	m.mu.Lock()
	slot := m.slots[sess.id]
	stillValid := slot != nil && slot.current == sess && !sess.closed
	if !stillValid {
		m.mu.Unlock()
		return OpenResult{}, false
	}
	sess.outMu.Lock()
	replayBytes, replayOffset := sess.replay.snapshot()
	exited := sess.exited
	exitCode := sess.exitCode
	sess.outMu.Unlock()
	gen := sess.generation
	cwd := sess.cwd
	shell := sess.shell
	m.mu.Unlock()

	var replayB64 string
	if len(replayBytes) > 0 {
		replayB64 = base64.StdEncoding.EncodeToString(replayBytes)
	}
	return OpenResult{
		OK:           true,
		Cwd:          cwd,
		Shell:        shell,
		Replay:       replayB64,
		Generation:   gen,
		ReplayOffset: int64Ptr(replayOffset),
		Exited:       exited,
		ExitCode:     exitCode,
	}, true
}

// Open 打开（或复用）一个终端会话。
func (m *Manager) Open(in OpenInput) OpenResult {
	return m.OpenOwnedContext(context.Background(), in, 0)
}

// OpenOwned 打开（或复用）归属指定连接 owner 的终端会话；若已存在则重绑 owner 并回放近期输出。
func (m *Manager) OpenOwned(in OpenInput, owner int) OpenResult {
	return m.OpenOwnedContext(context.Background(), in, owner)
}

// OpenOwnedContext 打开（或复用/替换）归属 owner 的终端会话；支持启动前取消登记与按身份+代次串行化。
func (m *Manager) OpenOwnedContext(ctx context.Context, in OpenInput, owner int) OpenResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if in.ID == "" || len(in.ID) > maxID {
		return openErr("failed", "invalid terminal id")
	}

	var oldToClose []*session
	defer func() {
		for _, s := range oldToClose {
			s.closePTY()
		}
	}()

	var pending *pendingStart
	var slot *termSlot
	for {
		if ctx.Err() != nil {
			return openErr("failed", ctx.Err().Error())
		}
		m.mu.Lock()
		slot = m.slots[in.ID]
		if !in.Replace && slot != nil {
			if existing := slot.current; existing != nil && !existing.closed {
				if owner > 0 {
					existing.owner = owner
				}
				m.mu.Unlock()
				if res, ok := m.reuseSessionResult(existing, in.Cols, in.Rows); ok {
					return res
				}
				// Resize 期间被并发关闭，重新进入调度
				continue
			}
			if inFlight := slot.starting; inFlight != nil && !inFlight.canceled {
				waitCh := inFlight.done
				m.mu.Unlock()
				select {
				case <-waitCh:
					continue
				case <-ctx.Done():
					return openErr("failed", ctx.Err().Error())
				}
			}
		}

		if in.Replace && slot != nil {
			if slot.current != nil {
				old := slot.current
				old.closed = true
				slot.current = nil
				oldToClose = append(oldToClose, old)
			}
			if prevStart := slot.starting; prevStart != nil {
				prevStart.canceled = true
				slot.starting = nil
				prevStart.finish()
			}
		}

		if m.activeCountLocked() >= maxTerminals {
			if slot != nil {
				m.pruneSlotLocked(in.ID, slot)
			}
			m.mu.Unlock()
			return openErr("limit", "too many terminals")
		}

		m.nextGen++
		gen := m.nextGen
		pending = &pendingStart{
			gen:   gen,
			owner: owner,
			done:  make(chan struct{}),
		}
		slot = m.slotLocked(in.ID)
		slot.starting = pending
		m.mu.Unlock()
		break
	}

	// 启动前先行回收被 Replace 摘除的旧会话，确保旧 PTY 释放后再启动新会话
	for _, s := range oldToClose {
		s.closePTY()
	}
	oldToClose = nil

	clearPending := func() {
		m.mu.Lock()
		if curSlot := m.slots[in.ID]; curSlot != nil && curSlot.starting == pending {
			curSlot.starting = nil
			m.pruneSlotLocked(in.ID, curSlot)
		}
		m.mu.Unlock()
		pending.finish()
	}

	m.mu.Lock()
	preCanceled := pending.canceled || ctx.Err() != nil
	m.mu.Unlock()
	if preCanceled {
		clearPending()
		return openErr("failed", "terminal open cancelled")
	}

	dir, reason, msg := m.resolveDir(in.ProjectID, in.Cwd, in.ExplicitCwd)
	if reason != "" {
		clearPending()
		return openErr(reason, msg)
	}

	m.mu.Lock()
	preCanceled = pending.canceled || ctx.Err() != nil
	m.mu.Unlock()
	if preCanceled {
		clearPending()
		return openErr("failed", "terminal open cancelled")
	}

	cols, rows := clampSize(in.Cols, in.Rows)
	p, err := m.deps.StartPTY(StartOptions{
		Dir:  dir,
		Cols: cols,
		Rows: rows,
	})
	if err != nil {
		clearPending()
		if errors.Is(err, ErrUnsupported) {
			return openErr("unsupported", err.Error())
		}
		return openErr("failed", err.Error())
	}

	sess := &session{
		id:         in.ID,
		generation: pending.gen,
		cwd:        dir,
		shell:      p.Shell(),
		pty:        p,
		owner:      pending.owner,
		replay:     newRingBuffer(replayBufSize),
		readDone:   make(chan struct{}),
	}

	m.mu.Lock()
	curSlot := m.slots[in.ID]
	if pending.canceled || ctx.Err() != nil || curSlot == nil || curSlot.starting != pending {
		if curSlot != nil && curSlot.starting == pending {
			curSlot.starting = nil
			m.pruneSlotLocked(in.ID, curSlot)
		}
		m.mu.Unlock()
		pending.finish()
		_ = p.Close()
		return openErr("failed", "terminal closed during startup")
	}

	curSlot.starting = nil
	curSlot.current = sess
	m.mu.Unlock()
	pending.finish()

	go m.pumpOutput(sess)
	go m.waitExit(sess)

	return OpenResult{
		OK:           true,
		Cwd:          sess.cwd,
		Shell:        sess.shell,
		Generation:   sess.generation,
		ReplayOffset: int64Ptr(0),
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
		startOffset := sess.replay.totalBytes
		sess.replay.write(data)
		sess.outMu.Unlock()

		m.mu.Lock()
		slot := m.slots[sess.id]
		closed := sess.closed || slot == nil || slot.current != sess
		m.mu.Unlock()
		if !closed && m.deps.Emit != nil {
			m.deps.Emit("sideTerminal.data", map[string]any{
				"id":         sess.id,
				"generation": sess.generation,
				"offset":     startOffset,
				"data":       base64.StdEncoding.EncodeToString(data),
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
	slot := m.slots[sess.id]
	stillTracked := slot != nil && slot.current == sess
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

	payload := map[string]any{
		"id":         sess.id,
		"generation": sess.generation,
	}
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

func (m *Manager) sessionFor(id string, gen int64) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	slot := m.slots[id]
	if slot == nil || slot.current == nil || slot.current.closed {
		return nil
	}
	if gen > 0 && slot.current.generation != gen {
		return nil
	}
	return slot.current
}

// Write 向指定终端写入数据。
func (m *Manager) Write(id, data string) bool {
	return m.WriteGeneration(id, data, 0)
}

// WriteGeneration 向指定代次的终端写入数据；gen > 0 且不匹配当前代次时拒绝写入。
func (m *Manager) WriteGeneration(id, data string, gen int64) bool {
	if id == "" || len(id) > maxID || data == "" || len(data) > maxWriteBytes {
		return false
	}
	sess := m.sessionFor(id, gen)
	if sess == nil {
		return false
	}
	_, err := sess.pty.Write([]byte(data))
	return err == nil
}

// Resize 同步指定终端的行列尺寸。
func (m *Manager) Resize(id string, cols, rows int) bool {
	return m.ResizeGeneration(id, cols, rows, 0)
}

// ResizeGeneration 同步指定代次终端的行列尺寸；gen > 0 且不匹配时忽略。
func (m *Manager) ResizeGeneration(id string, cols, rows int, gen int64) bool {
	if id == "" || len(id) > maxID {
		return false
	}
	sess := m.sessionFor(id, gen)
	if sess == nil {
		return false
	}
	c, r := clampSize(cols, rows)
	return sess.pty.Resize(c, r) == nil
}

// Close 关闭并移除指定终端会话（含启动中可取消槽位）。
func (m *Manager) Close(id string) bool {
	return m.CloseGeneration(id, 0)
}

// CloseGeneration 按代次关闭并移除终端：gen > 0 时只清理 generation <= gen 的已上线或启动中会话，绝不误杀新代次。
func (m *Manager) CloseGeneration(id string, gen int64) bool {
	if id == "" || len(id) > maxID {
		return false
	}
	m.mu.Lock()
	slot := m.slots[id]
	if slot == nil {
		m.mu.Unlock()
		return false
	}
	var toClose *session
	acted := false
	if slot.current != nil && (gen <= 0 || slot.current.generation <= gen) {
		slot.current.closed = true
		toClose = slot.current
		slot.current = nil
		acted = true
	}
	if slot.starting != nil && (gen <= 0 || slot.starting.gen <= gen) {
		slot.starting.canceled = true
		slot.starting.finish()
		slot.starting = nil
		acted = true
	}
	m.pruneSlotLocked(id, slot)
	m.mu.Unlock()
	if toClose != nil {
		toClose.closePTY()
	}
	return acted
}

// Sync 对账 owner 名下存活的终端 id，清理不在此清单中的孤儿进程及启动中会话。
func (m *Manager) Sync(owner int, ids []string) []string {
	want := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id != "" && len(id) <= maxID {
			want[id] = struct{}{}
		}
	}
	m.mu.Lock()
	var gone []*session
	closedSet := map[string]struct{}{}
	for id, slot := range m.slots {
		if _, keep := want[id]; keep {
			continue
		}
		if sess := slot.current; sess != nil && (owner <= 0 || sess.owner == owner) {
			sess.closed = true
			slot.current = nil
			gone = append(gone, sess)
			closedSet[id] = struct{}{}
		}
		if st := slot.starting; st != nil && (owner <= 0 || st.owner == owner) {
			st.canceled = true
			st.finish()
			slot.starting = nil
			closedSet[id] = struct{}{}
		}
		m.pruneSlotLocked(id, slot)
	}
	m.mu.Unlock()

	for _, sess := range gone {
		sess.closePTY()
	}
	closedIDs := make([]string, 0, len(closedSet))
	for id := range closedSet {
		closedIDs = append(closedIDs, id)
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

// CloseAll 关闭并回收所有活跃及启动中的终端进程（应用退出或整页重载兜底）。
func (m *Manager) CloseAll() {
	m.mu.Lock()
	all := make([]*session, 0, len(m.slots))
	for _, slot := range m.slots {
		if slot.current != nil {
			slot.current.closed = true
			all = append(all, slot.current)
		}
		if slot.starting != nil {
			slot.starting.canceled = true
			slot.starting.finish()
		}
	}
	m.slots = map[string]*termSlot{}
	m.mu.Unlock()
	for _, sess := range all {
		sess.closePTY()
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
	r.Call("sideTerminal.open", func(ctx context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
		var in OpenInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		m.watch(c)
		return m.OpenOwnedContext(ctx, in, c.ID), nil
	})
	r.Call("sideTerminal.write", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID         string `json:"id"`
			Data       string `json:"data"`
			Generation int64  `json:"generation,omitempty"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.WriteGeneration(in.ID, in.Data, in.Generation), nil
	})
	r.Call("sideTerminal.resize", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID         string `json:"id"`
			Cols       int    `json:"cols"`
			Rows       int    `json:"rows"`
			Generation int64  `json:"generation,omitempty"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.ResizeGeneration(in.ID, in.Cols, in.Rows, in.Generation), nil
	})
	r.Call("sideTerminal.close", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID         string `json:"id"`
			Generation int64  `json:"generation,omitempty"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad("input")
		}
		return m.CloseGeneration(in.ID, in.Generation), nil
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
