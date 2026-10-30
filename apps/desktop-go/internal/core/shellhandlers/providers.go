package shellhandlers

// providers.* —— apps/desktop-electron/internal/core/src/contract/shell.ts 的 withProviders / bindProviderEvents 部分。
// 服务是 AI runtime 的 ProviderService（internal/ai/providers）；生产路径与 AIRuntimeBoot 一致：
// 内存 ProviderStore（无 filePath）+ createSafeStorageCipher(secrets) + 环境变量 provider。

import (
	"context"
	"encoding/json"
	"log"
	"regexp"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var providerSecretLike = regexp.MustCompile(`\b(sk|key|AIza)[-_A-Za-z0-9]{12,}\b`)

// redactProviderError：错误信息里形似 Key 的片段打码，不挂原始错误
func redactProviderError(err error) error {
	return &plainError{u.UTF16Slice0(providerSecretLike.ReplaceAllString(err.Error(), "***"), 300)}
}

type plainError struct{ msg string }

func (e *plainError) Error() string { return e.msg }

// InstallProviders：注册 providers.presets / meta / state / setActive，并把 onChange 发布为 providers.changed。
// svc 为 nil 时各过程以 UNAVAILABLE 失败（= need(s.aiRuntime, 'aiRuntime')）。
func InstallProviders(r *contract.Router, svc *providers.Service) {
	if svc != nil {
		svc.OnChange(func() { r.Emit("providers.changed", svc.State()) })
	}
	with := func(fn func(p *providers.Service) (any, error)) (any, error) {
		if svc == nil {
			return nil, &contract.Error{Code: "UNAVAILABLE", Message: "Service 'aiRuntime' is not available"}
		}
		v, err := fn(svc)
		if err != nil {
			return nil, redactProviderError(err)
		}
		return v, nil
	}
	r.Call("providers.presets", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return with(func(p *providers.Service) (any, error) { return p.Presets(), nil })
	})
	r.Call("providers.meta", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return with(func(p *providers.Service) (any, error) { return p.Meta(), nil })
	})
	r.Call("providers.state", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return with(func(p *providers.Service) (any, error) { return p.State(), nil })
	})
	r.Call("providers.setActive", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in *u.Obj
		if len(raw) > 0 {
			v, err := u.Parse(raw)
			if err != nil {
				return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
			}
			in, _ = v.(*u.Obj)
		}
		id, ok := in.Lookup("id")
		if !ok {
			id = u.Undefined
		}
		model, ok := in.Lookup("model")
		if !ok || model == nil {
			model = u.Undefined // model ?? undefined
		}
		return with(func(p *providers.Service) (any, error) { return p.SetActive(id, model) })
	})
}

// secretBoxStorage：把 SecretBox 适配成 SafeStorageLike（Node：safeStorageFromSecrets(ports.secrets)）
type SecretBoxLike interface {
	CanEncrypt() bool
	Encrypt(value, unavailableMessage string) (string, error)
	Decrypt(value string) string
}

type secretBoxStorage struct{ b SecretBoxLike }

func (s secretBoxStorage) IsEncryptionAvailable() bool       { return s.b.CanEncrypt() }
func (s secretBoxStorage) GetSelectedStorageBackend() string { return "" }
func (s secretBoxStorage) EncryptString(plain string) ([]byte, error) {
	v, err := s.b.Encrypt(plain, "safeStorage unavailable")
	return []byte(v), err
}
func (s secretBoxStorage) DecryptString(buf []byte) (string, error) {
	return s.b.Decrypt(string(buf)), nil
}

// NomiRouteFunc：services.gateway()?.nomiRoute(role) ?? null（nil 函数 = 网关不可用）
type NomiRouteFunc func(role string) *providers.GatewayResolution

type gatewayRoute struct{ f NomiRouteFunc }

func (g gatewayRoute) Resolve(role string) *providers.GatewayResolution {
	if g.f == nil {
		return nil
	}
	return g.f(role)
}

// NewProviderService：AIRuntimeBoot 的 ProviderStore + ProviderService + RoutedLLMRegistry
// （AiSdkLLMProvidersPlugin：env providers、store、gateway 路由；registry 经 getRegistry 交给 ProviderService）
func NewProviderService(box SecretBoxLike, env map[string]string, onCall func(any)) *providers.Service {
	svc, _ := NewProviderRuntime(box, env, onCall, nil)
	return svc
}

// NewProviderRuntime：同 NewProviderService，并返回 registry（chat procs 用）
func NewProviderRuntime(box SecretBoxLike, env map[string]string, onCall func(any), nomiRoute NomiRouteFunc) (*providers.Service, *providers.RoutedLLMRegistry) {
	var cipher providers.SecretCipher = providers.PlaintextCipher
	if box != nil {
		cipher = providers.CreateSafeStorageCipher(secretBoxStorage{box})
	}
	store := providers.NewStore(providers.StoreOptions{Cipher: cipher, OnCall: onCall})
	entries := runtimeEntries(env)
	var envProviders []blm.LLMProvider
	for _, e := range entries {
		p, err := aisdk.NewProvider(aisdk.EnvProviderConfig(e), nil)
		if err != nil {
			log.Printf("[ai-runtime] register provider failed: %s %v", e.ID, err)
			continue
		}
		envProviders = append(envProviders, p)
	}
	registry := providers.NewRoutedLLMRegistry(providers.RoutedRegistryOptions{
		Store:        store,
		EnvProviders: envProviders,
		Gateway:      gatewayRoute{nomiRoute},
		OverrideID:   runtimeOverride(env),
		OnError:      func(msg string, err error) { log.Printf("[ai-runtime] %s %v", msg, err) },
		OnCall: func(e *u.Obj) {
			if e.Get("ok") == true {
				log.Printf("[ai-runtime] llm call %v %v %s", e.Get("provider"), e.Get("model"), u.Stringify(e))
			} else {
				log.Printf("[ai-runtime] llm call failed %v %v %s", e.Get("provider"), e.Get("model"), u.Stringify(e))
			}
		},
	})
	svc := providers.NewService(providers.ServiceOptions{
		Store:       store,
		EnvEntries:  entries,
		GetRegistry: func() providers.RoutedRegistry { return registry },
		OverrideID:  runtimeOverride(env),
	})
	return svc, registry
}
