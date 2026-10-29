package voice

// 对应 VoiceService.ts 的「豆包流式识别」一节：streamStart / streamPush / streamStop / streamCancel、
// volcBatch / volcFallback / volcTest，以及按发起窗口管理的会话（MAX_STREAMS_PER_SENDER、窗口销毁撤销）。

import (
	"errors"
	"fmt"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Sender = VoiceSender（契约调用方：caller.id + 是否已销毁 + 'ai:voice:stream' 推送 + once('destroyed')）
type Sender interface {
	ID() int
	IsDestroyed() bool
	Send(channel string, payload *util.Obj)
	OnceDestroyed(fn func())
}

// VolcTimeouts = VoiceDeps.volcTimeouts（0 = 默认）
type VolcTimeouts struct{ Connect, Final, Idle, ProbeWait time.Duration }

const (
	maxStreamBytes      = 25 * 1024 * 1024
	maxPushBytes        = 64 * 1024
	maxStreamsPerSender = 2
)

type volcStream struct {
	session *VolcSession
	owner   int
	source  string
	started int64
	bytes   int
	pcm     [][]byte // nil = 不保留
	keepPCM bool
	phase   string
	revoked *Error
}

type streamEntry struct {
	id  string
	rec *volcStream
}

func (s *Service) localOnlyError() *Error {
	return &Error{"local_only", s.d.T("electron.common.local-models-only-is-on-recordings-can-t")}
}

func (s *Service) newVolcSession(st Settings, onPartial func(string)) *VolcSession {
	to := s.d.VolcTimeouts
	return NewVolcSession(VolcOpts{
		APIKey: s.volcKey(), ResourceID: st.VolcResourceID, URL: s.d.VolcURL,
		ConnectTimeout: to.Connect, FinalTimeout: to.Final, IdleTimeout: to.Idle,
		OnPartial: onPartial,
		MayUpload: func() bool { return !s.localOnly() },
		T:         func(k string) string { return s.d.T(k) },
	})
}

// volcBatch：整段音频走豆包，建连后按 200ms 分包推送
func (s *Service) volcBatch(st Settings, pcm []byte) (string, error) {
	sess := s.newVolcSession(st, nil)
	if err := sess.Start(); err != nil {
		return "", err
	}
	pace := 40 * time.Millisecond
	if s.d.VolcPace != nil {
		pace = *s.d.VolcPace
	}
	for o := 0; o < len(pcm); o += VolcPacketBytes {
		if s.localOnly() {
			sess.Cancel()
			return "", s.localOnlyError()
		}
		sess.Push(pcm[o:min(len(pcm), o+VolcPacketBytes)])
		if pace > 0 {
			time.Sleep(pace)
		}
	}
	return sess.Finish()
}

// volcFallback：云端失败时按设置改用本地 whisper.cpp，否则抛出可读错误
func (s *Service) volcFallback(st Settings, e error, pcm []byte) (string, error) {
	var ve *Error
	if errors.As(e, &ve) {
		return "", e
	}
	var err *VolcAsrError
	errors.As(e, &err)
	if err != nil && err.Kind == "cancelled" {
		return "", &Error{"empty", err.Message}
	}
	message := e.Error()
	if st.VolcFallback && err != nil {
		if s.localReady(st) && len(pcm) >= 3200 {
			s.d.Logf("豆包识别失败，改用本地 whisper.cpp kind=%s", err.Kind)
			return s.localTranscribe(contextBG(), PcmToWav(pcm), "command")
		}
		return "", &Error{"failed", s.d.T("electron.common.the-local-offline-model-isn-t-installed-so", message)}
	}
	code := "failed"
	if err != nil && (err.Kind == "auth" || err.Kind == "not_granted") {
		code = "no_provider"
	} else if err != nil && err.Kind == "empty" {
		code = "empty"
	}
	return "", &Error{code, message}
}

func (s *Service) sendStream(wc Sender, payload *util.Obj) {
	if !wc.IsDestroyed() {
		wc.Send("ai:voice:stream", payload)
	}
}

// StreamStart = streamStart(wc, source)
func (s *Service) StreamStart(wc Sender, source string) *util.Obj {
	s.mu.Lock()
	st := s.settings
	if st.Engine != "volc" {
		s.mu.Unlock()
		return util.NewObj("ok", false, "code", "no_provider", "error", s.d.T("electron.common.the-current-recognition-engine-doesn-t-support-streaming"))
	}
	s.mu.Unlock()
	r := s.readiness(st)
	if !r.OK {
		code := r.Code
		if code == "" {
			code = "failed"
		}
		return util.NewObj("ok", false, "code", code, "error", r.Message)
	}
	s.mu.Lock()
	var mine []streamEntry
	for _, e := range s.streams {
		if e.rec.owner == wc.ID() {
			mine = append(mine, e)
		}
	}
	for _, e := range mine[:max(0, len(mine)-maxStreamsPerSender+1)] {
		s.revokeStreamLocked(e.id, e.rec, nil)
	}
	s.streamSeq++
	id := fmt.Sprintf("%d:%d", wc.ID(), s.streamSeq)
	var sess *VolcSession
	sess = s.newVolcSession(st, func(text string) {
		s.mu.Lock()
		rec := s.findStream(id)
		ok := rec != nil && rec.session == sess && rec.phase == "recording"
		s.mu.Unlock()
		if ok {
			s.sendStream(wc, util.NewObj("id", id, "type", "partial", "text", text))
		}
	})
	rec := &volcStream{session: sess, owner: wc.ID(), source: util.UTF16Slice0(source, 32), started: s.nowMs(), phase: "recording", keepPCM: st.VolcFallback}
	if rec.keepPCM {
		rec.pcm = [][]byte{}
	}
	s.streams = append(s.streams, streamEntry{id, rec})
	if !s.streamOwners[wc.ID()] {
		s.streamOwners[wc.ID()] = true
		owner := wc.ID()
		wc.OnceDestroyed(func() {
			s.mu.Lock()
			delete(s.streamOwners, owner)
			for _, e := range append([]streamEntry(nil), s.streams...) {
				if e.rec.owner == owner {
					s.revokeStreamLocked(e.id, e.rec, nil)
				}
			}
			s.unlockCancel()
		})
	}
	s.unlockCancel()
	go func() {
		e := sess.Start()
		if e == nil {
			return
		}
		s.mu.Lock()
		cur := s.findStream(id)
		s.mu.Unlock()
		if cur == nil || cur.session != sess {
			return
		}
		var err *VolcAsrError
		if errors.As(e, &err) && err.Kind == "cancelled" {
			return
		}
		s.sendStream(wc, util.NewObj("id", id, "type", "error", "error", e.Error()))
	}()
	return util.NewObj("ok", true, "id", id)
}

func (s *Service) findStream(id string) *volcStream {
	for _, e := range s.streams {
		if e.id == id {
			return e.rec
		}
	}
	return nil
}

func (s *Service) deleteStream(id string, rec *volcStream) {
	for i, e := range s.streams {
		if e.id == id && e.rec == rec {
			s.streams = append(s.streams[:i:i], s.streams[i+1:]...)
			return
		}
	}
}

func (s *Service) ownStream(wc Sender, id string) *volcStream {
	rec := s.findStream(id)
	if rec != nil && rec.owner == wc.ID() {
		return rec
	}
	return nil
}

// StreamPush = streamPush(wc, id, pcm)；pcm == nil 表示不是 Uint8Array / ArrayBuffer
func (s *Service) StreamPush(wc Sender, id string, pcm []byte) bool {
	s.mu.Lock()
	rec := s.ownStream(wc, id)
	if rec == nil || rec.phase != "recording" {
		s.mu.Unlock()
		return false
	}
	if pcm == nil || len(pcm) == 0 || len(pcm) > maxPushBytes {
		s.mu.Unlock()
		return false
	}
	if s.localOnly() || s.settings.Engine != "volc" {
		err := s.localOnlyError()
		s.revokeStreamLocked(id, rec, err)
		s.unlockCancel()
		s.sendStream(wc, util.NewObj("id", id, "type", "error", "code", err.Code, "error", err.Message))
		return false
	}
	rec.bytes += len(pcm)
	if rec.bytes > maxStreamBytes {
		err := &Error{"failed", s.d.T("electron.common.recording-too-long-max-about-13-minutes")}
		s.revokeStreamLocked(id, rec, err)
		s.unlockCancel()
		s.sendStream(wc, util.NewObj("id", id, "type", "error", "error", err.Message))
		return false
	}
	if rec.pcm != nil {
		rec.pcm = append(rec.pcm, append([]byte(nil), pcm...))
	}
	sess := rec.session
	s.mu.Unlock()
	sess.Push(pcm)
	return true
}

// StreamStop = streamStop(wc, id)
func (s *Service) StreamStop(wc Sender, id string) *util.Obj {
	s.mu.Lock()
	rec := s.ownStream(wc, id)
	if rec == nil || rec.phase != "recording" {
		s.mu.Unlock()
		return util.NewObj("ok", false, "code", "failed", "error", s.d.T("electron.common.the-recognition-session-has-already-ended"))
	}
	rec.phase = "finalizing"
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.deleteStream(id, rec)
		s.mu.Unlock()
	}()
	return s.finishStream(id, rec)
}

func (s *Service) finishStream(id string, rec *volcStream) *util.Obj {
	s.mu.Lock()
	var pcm []byte
	for _, b := range rec.pcm {
		pcm = append(pcm, b...)
	}
	rec.pcm = nil
	st := s.settings
	s.mu.Unlock()
	var text string
	fallback := false
	run := func() error {
		if s.localOnly() {
			err := s.localOnlyError()
			s.mu.Lock()
			s.revokeStreamLocked(id, rec, err)
			s.unlockCancel()
			return err
		}
		t, e := rec.session.Finish()
		if e != nil {
			if rv := s.revokedReason(rec); rv != nil {
				return rv
			}
			s.mu.Lock()
			st = s.settings
			s.mu.Unlock()
			t, e = s.volcFallback(st, e, pcm)
			if e != nil {
				return e
			}
			fallback = true
		}
		text = util.JSTrim(t)
		if rv := s.revokedReason(rec); rv != nil {
			return rv
		}
		return nil
	}
	secs := jsRound(float64(rec.bytes) / 32000)
	if err := run(); err != nil {
		code := "failed"
		var ve *Error
		if errors.As(err, &ve) {
			code = ve.Code
		}
		ms := s.nowMs() - rec.started
		s.audit(AuditEvent{Tool: "voice_transcribe", Args: util.NewObj("source", rec.source, "engine", "volc", "seconds", secs),
			Decision: "auto", Result: "error", Ms: &ms, Provider: VolcTargetID})
		return util.NewObj("ok", false, "code", code, "error", err.Error())
	}
	args := util.NewObj("source", rec.source, "engine", "volc", "seconds", secs)
	if fallback {
		args.Set("fallback", "whisper.cpp")
	}
	result := "empty"
	if text != "" {
		result = "ok"
	}
	ms := s.nowMs() - rec.started
	s.audit(AuditEvent{Tool: "voice_transcribe", Args: args, Decision: "auto", Result: result, Ms: &ms, Provider: VolcTargetID})
	if fallback {
		return util.NewObj("ok", true, "text", text, "fallback", true)
	}
	return util.NewObj("ok", true, "text", text)
}

// StreamCancel = streamCancel(wc, id)
func (s *Service) StreamCancel(wc Sender, id string) bool {
	s.mu.Lock()
	rec := s.ownStream(wc, id)
	if rec == nil {
		s.mu.Unlock()
		return false
	}
	s.revokeStreamLocked(id, rec, nil)
	s.unlockCancel()
	return true
}

func (s *Service) cancelStreamsLocked() {
	for _, e := range append([]streamEntry(nil), s.streams...) {
		s.revokeStreamLocked(e.id, e.rec, nil)
	}
}

func (s *Service) revokeStreamLocked(id string, rec *volcStream, reason *Error) {
	if rec.revoked == nil {
		if reason == nil {
			reason = &Error{"empty", s.d.T("electron.common.cancelled")}
		}
		rec.revoked = reason
	}
	rec.pcm = nil
	// session.cancel() 在释放 s.mu 后执行（会话回调会拿 s.mu，锁序：会话锁 → s.mu）
	s.toCancel = append(s.toCancel, rec.session)
	s.deleteStream(id, rec)
}

// unlockCancel：释放 s.mu，再取消撤销期间登记的会话
func (s *Service) unlockCancel() {
	c := s.toCancel
	s.toCancel = nil
	s.mu.Unlock()
	for _, x := range c {
		x.Cancel()
	}
}

func (s *Service) revokedReason(rec *volcStream) *Error {
	s.mu.Lock()
	rv := rec.revoked
	s.mu.Unlock()
	if rv != nil {
		return rv
	}
	if e := rec.session.Err(); e != nil && e.Kind == "cancelled" && s.localOnly() {
		return s.localOnlyError()
	}
	return nil
}

// VolcTest = volcTest()
func (s *Service) VolcTest() *util.Obj {
	s.mu.Lock()
	st := s.settings
	s.mu.Unlock()
	if st.Engine != "volc" {
		return util.NewObj("ok", false, "message", s.d.T("electron.common.switch-the-recognition-engine-to-doubao-streaming-asr"))
	}
	if r := s.readiness(st); !r.OK {
		return util.NewObj("ok", false, "message", r.Message)
	}
	to := s.d.VolcTimeouts
	_, _, err := ProbeVolc(VolcOpts{APIKey: s.volcKey(), ResourceID: st.VolcResourceID, URL: s.d.VolcURL,
		ConnectTimeout: to.Connect, T: func(k string) string { return s.d.T(k) }}, to.ProbeWait)
	if err != nil {
		s.audit(AuditEvent{Tool: "voice_volc_test", Args: util.NewObj(), Decision: "user", Result: "error"})
		return util.NewObj("ok", false, "message", err.Error())
	}
	s.audit(AuditEvent{Tool: "voice_volc_test", Args: util.NewObj(), Decision: "user", Result: "ok"})
	return util.NewObj("ok", true, "message", s.d.T("electron.common.connected-to-doubao-speech-and-authenticated-no-audio"))
}
