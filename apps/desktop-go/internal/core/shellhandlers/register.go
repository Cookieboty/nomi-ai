// Package shellhandlers 把 theme/locale/startup/onboarding 等批次 2–3 的契约过程挂到 Router。
package shellhandlers

import (
	"context"
	"encoding/json"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/onboarding"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/settings"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/startup"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/theme"
)

type Deps struct {
	UserData    string
	Router      *contract.Router
	OpenChat    func()
	SystemLangs []string
	IsDark      func() bool
	// LiveWindows：宿主存活窗口数（= host.liveWindows；onboarding.mascot 据此判断送达）
	LiveWindows func() int
}

type Bundle struct {
	Theme      *theme.Service
	Startup    *startup.Service
	Onboarding *onboarding.Service
	Locale     *i18n.Service
	Config     *services.ConfigService
	Settings   *settings.Store
	// OnLocaleChange：界面语言变化后回调（= i18n.onChange，人设据此重算）
	OnLocaleChange []func()
	// OnStartupChange：启动偏好变化后回调（= startup.onChange，宿主据此显隐看板娘）
	OnStartupChange []func(startup.State)
}

func Install(d Deps) *Bundle {
	r := d.Router
	b := &Bundle{
		Config:   services.NewConfig(d.UserData),
		Settings: settings.New(filepath.Join(d.UserData, "settings.json")),
	}
	b.Theme = theme.New(filepath.Join(d.UserData, "theme.json"), d.IsDark, func(s theme.State) {
		r.Emit("theme.changed", s)
	})
	b.Startup = startup.New(filepath.Join(d.UserData, "startup.json"), func(s startup.State) {
		r.Emit("startup.changed", s)
		for _, fn := range b.OnStartupChange {
			fn(s)
		}
	})
	b.Locale = i18n.New(filepath.Join(d.UserData, "locale.json"), d.SystemLangs, func(s i18n.State) {
		r.Emit("locale.changed", s)
		for _, fn := range b.OnLocaleChange {
			fn()
		}
	})
	b.Onboarding = onboarding.New(d.UserData, d.OpenChat, func(s onboarding.State) {
		r.Emit("onboarding.show", s)
	}, func(p onboarding.Profile) {
		r.Emit("onboarding.profileChanged", p)
	})
	b.Onboarding.SetMascotPorts(onboarding.MascotPorts{Publish: r.Emit, LiveWindows: d.LiveWindows})

	r.Call("theme.get", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return b.Theme.Get(), nil
	})
	r.Call("theme.set", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Pref any `json:"pref"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		st, err := b.Theme.Set(in.Pref)
		if err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		return st, nil
	})

	r.Call("startup.get", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return b.Startup.Get(), nil
	})
	r.Call("startup.set", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var patch map[string]any
		if err := json.Unmarshal(raw, &patch); err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		st, err := b.Startup.Set(patch)
		if err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		return st, nil
	})

	r.Call("locale.get", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return b.Locale.Get(), nil
	})
	r.Call("locale.set", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Pref any `json:"pref"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		st, err := b.Locale.Set(in.Pref)
		if err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		return st, nil
	})
	r.Call("locale.dict", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return b.Locale.Dict(), nil
	})

	r.Call("onboarding.get", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return b.Onboarding.Get(), nil
	})
	r.Call("onboarding.complete", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Skipped *bool `json:"skipped"`
		}
		_ = json.Unmarshal(raw, &in)
		return b.Onboarding.Complete(in.Skipped != nil && *in.Skipped), nil
	})
	r.Call("onboarding.reopen", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return b.Onboarding.Reopen(), nil
	})
	r.Call("onboarding.profile", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return b.Onboarding.Profile(), nil
	})
	r.Call("onboarding.setProfile", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Role      *string  `json:"role"`
			Interests []string `json:"interests"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		return b.Onboarding.SetProfile(in.Role, in.Interests), nil
	})
	r.Call("onboarding.mascot", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		return b.Onboarding.Mascot(raw), nil
	})

	return b
}
