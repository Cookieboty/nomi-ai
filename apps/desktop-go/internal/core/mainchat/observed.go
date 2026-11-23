package mainchat

import (
	"context"
	"errors"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

type observedRuntime struct {
	cr.Runtime
	notify func()
}

func (o *observedRuntime) Start(ctx context.Context, request cr.RuntimeRequest, accept func(cr.Event) error) cr.SubmitResult {
	return o.Runtime.Start(ctx, request, func(e cr.Event) error {
		err := accept(e)
		if err == nil || errors.Is(err, cr.ErrUnknownState) || errors.Is(err, cr.ErrPermission) || errors.Is(err, cr.ErrProtocol) {
			o.notify()
		}
		return err
	})
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
