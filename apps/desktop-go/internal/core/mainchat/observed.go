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
