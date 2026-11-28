package mainchat

import (
	"context"
	"errors"
	"sync"
	"time"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

const streamNotifyInterval = 50 * time.Millisecond

type observedRuntime struct {
	cr.Runtime
	notify       func()
	streamNotify func()
	onCompleted  func(cr.Event)

	mu         sync.Mutex
	lastStream time.Time
	timer      *time.Timer
	seq        uint64
}

func (o *observedRuntime) Start(ctx context.Context, request cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	res := o.Runtime.Start(ctx, request, func(e cr.Event) error {
		err := accept(e)
		if err == nil {
			if e.Kind == cr.EventStream || e.Kind == cr.EventTrace || e.Kind == cr.EventContext || e.Kind == cr.EventMeta {
				o.scheduleStream(e.Kind != cr.EventStream)
				return nil
			}
			if e.Kind == cr.EventCompleted && o.onCompleted != nil {
				o.onCompleted(e)
			}
			o.flushAuthoritative()
			return nil
		}
		if errors.Is(err, cr.ErrUnknownState) || errors.Is(err, cr.ErrPermission) || errors.Is(err, cr.ErrProtocol) {
			o.flushAuthoritative()
		}
		return err
	})
	return res
}

func (o *observedRuntime) scheduleStream(immediate bool) {
	fn := o.streamNotify
	if fn == nil {
		fn = o.notify
	}
	if fn == nil {
		return
	}
	o.mu.Lock()
	elapsed := time.Since(o.lastStream)
	if immediate || elapsed >= streamNotifyInterval {
		if o.timer != nil {
			o.timer.Stop()
			o.timer = nil
		}
		o.seq++
		o.lastStream = time.Now()
		o.mu.Unlock()
		fn()
		return
	}
	if o.timer == nil {
		delay := streamNotifyInterval - elapsed
		armedSeq := o.seq
		o.timer = time.AfterFunc(delay, func() {
			o.mu.Lock()
			if o.seq != armedSeq {
				o.mu.Unlock()
				return
			}
			o.timer = nil
			o.seq++
			o.lastStream = time.Now()
			o.mu.Unlock()
			fn()
		})
	}
	o.mu.Unlock()
}

func (o *observedRuntime) flushAuthoritative() {
	o.mu.Lock()
	o.seq++
	if o.timer != nil {
		o.timer.Stop()
		o.timer = nil
	}
	o.mu.Unlock()
	if o.notify != nil {
		o.notify()
	}
}

// Recover publishes an authority-changing resolution (proven native loss)
// exactly like an event would; unproven preparation does not notify.
func (o *observedRuntime) Recover(ctx context.Context, q cr.RecoveryRequest) cr.RecoveryResult {
	r := o.Runtime.Recover(ctx, q)
	if r.Lost {
		o.notify()
	}
	return r
}

func (o *observedRuntime) PrepareSwitch(ctx context.Context) error {
	if sw, ok := o.Runtime.(cr.SwitchAwareRuntime); ok {
		return sw.PrepareSwitch(ctx)
	}
	return nil
}

func (o *observedRuntime) Teardown(ctx context.Context) error {
	if sw, ok := o.Runtime.(cr.SwitchAwareRuntime); ok {
		return sw.Teardown(ctx)
	}
	return nil
}

// UnwrapRuntime identifies the shared owner for switch target cleanup.
func (o *observedRuntime) UnwrapRuntime() cr.Runtime { return o.Runtime }
