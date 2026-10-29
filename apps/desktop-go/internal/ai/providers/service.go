package providers

// ProviderService —— 对应 packages/ai-runtime/src/providers/ProviderService.ts 的 CRUD / 状态部分。
// test / testDraft / fetchModels / fetchModelsDraft 依赖 LLM 适配器与 fetch，属批次 5
// （docs/design/migrate-2.0.5-go.md D-B4d-3）。

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Resolved：RoutedLLMRegistry.resolve('chat') 的结果（Model "" = undefined）
type Resolved struct {
	ProviderID string
	Model      *string
}

// RoutedRegistry：ProviderService 用到的 RoutedLLMRegistry 子集（批次 5 实现）
type RoutedRegistry interface {
	Resolve(role string) (Resolved, bool)
}

// ServiceOptions：ProviderServiceOptions（CRUD 部分）
type ServiceOptions struct {
	Store       *Store
	EnvEntries  []llm.LLMProviderEntry
	GetRegistry func() RoutedRegistry
	// OverrideID："" = undefined
	OverrideID string
}

// Service：ProviderService
type Service struct{ opts ServiceOptions }

// NewService：new ProviderService(opts)
func NewService(opts ServiceOptions) *Service { return &Service{opts: opts} }

var secretLike = regexp.MustCompile(`\b(sk|key|AIza)[-_A-Za-z0-9]{12,}\b`)

// RedactSecrets：把 key / token 样式的片段从错误信息里抹掉
func RedactSecrets(msg string, secrets []string) string {
	out := msg
	for _, s := range secrets {
		if s != "" && u.UTF16Len(s) >= 4 {
			out = strings.Join(strings.Split(out, s), "***")
		}
	}
	return u.UTF16Slice0(secretLike.ReplaceAllString(out, "***"), 300)
}

// OnChange：onChange(listener)
func (s *Service) OnChange(l func()) func() { return s.opts.Store.OnChange(l) }

// Presets：PROVIDER_PRESETS
func (s *Service) Presets() []any {
	out := []any{}
	for _, p := range ProviderPresets() {
		out = append(out, p)
	}
	return out
}

// Meta：{ categories, protocols }
func (s *Service) Meta() *u.Obj {
	return u.NewObj("categories", PresetCategoryLabels(), "protocols", protocol.ProtocolLabels())
}

func envName(id string) string {
	pid := id
	if id == "claude" {
		pid = "anthropic"
	}
	name := id
	if p := FindPreset(pid); p != nil {
		if n := prop(p, "name"); !nullish(n) {
			name = jsString(n)
		}
	}
	return name + "（环境变量）"
}

// State：state()
func (s *Service) State() *u.Obj {
	st := s.opts.Store
	usage := st.Usage()
	activeID := st.ActiveProviderID()
	var effective any = undef
	var resolvedModel any = undef
	if s.opts.GetRegistry != nil {
		if reg := s.opts.GetRegistry(); reg != nil {
			if r, ok := reg.Resolve("chat"); ok {
				effective = r.ProviderID
				if r.Model != nil {
					resolvedModel = *r.Model
				}
			}
		}
	}
	effectiveModel := resolvedModel
	if nullish(effectiveModel) && truthy(effective) {
		for _, p := range st.Providers() {
			if strictEq(prop(p, "id"), effective) {
				effectiveModel = prop(p, "defaultModel")
				break
			}
		}
		if nullish(effectiveModel) {
			for _, e := range s.opts.EnvEntries {
				if e.ID == effective {
					effectiveModel = aisdk.EnvProviderConfig(e).DefaultModel
					break
				}
			}
		}
	}
	envs := []any{}
	for _, e := range s.opts.EnvEntries {
		c := aisdk.EnvProviderConfig(e)
		keyless := c.RequiresAPIKey != nil && !*c.RequiresAPIKey
		envs = append(envs, u.NewObj(
			"id", e.ID,
			"name", envName(e.ID),
			"protocol", c.Protocol,
			"baseURL", c.BaseURL,
			"defaultModel", c.DefaultModel,
			"hasKey", e.APIKey != "" || keyless,
			"keyless", keyless,
			"active", strictEq(activeID, e.ID),
			"usage", spreadInto(emptyUsage(), prop(usage, e.ID)),
			"source", "env",
		))
	}
	roles := make([]any, len(ProviderRoles))
	for i, r := range ProviderRoles {
		roles[i] = r
	}
	return u.NewObj(
		"providers", st.List(),
		"envProviders", envs,
		"activeProviderId", activeID,
		"effectiveProviderId", effective,
		"effectiveModel", effectiveModel,
		"routes", st.Routes(),
		"roles", roles,
		"encryption", st.Encryption(),
		"overrideId", strOrUndef(s.opts.OverrideID),
	)
}

func (s *Service) assertKnown(id any) error {
	known := false
	if sid, ok := id.(string); ok {
		known = s.opts.Store.Has(sid)
		for _, e := range s.opts.EnvEntries {
			if e.ID == sid {
				known = true
			}
		}
	}
	if !known {
		return fmt.Errorf("provider '%s' 不存在", jsString(id))
	}
	return nil
}

// Upsert：upsert(input)
func (s *Service) Upsert(input *u.Obj) (*u.Obj, error) { return s.opts.Store.Upsert(input) }

// Remove：remove(id)
func (s *Service) Remove(id string) error { return s.opts.Store.Remove(id) }

// SetActive：setActive(id | null, model?)
func (s *Service) SetActive(id any, model any) (*u.Obj, error) {
	if truthy(id) {
		if err := s.assertKnown(id); err != nil {
			return nil, err
		}
	}
	if nullish(id) {
		id = undef
	}
	if err := s.opts.Store.SetActive(id, model); err != nil {
		return nil, err
	}
	return s.State(), nil
}

// SetModels：setModels(id, enabled)
func (s *Service) SetModels(id string, enabled any) (*u.Obj, error) {
	return s.opts.Store.SetModels(id, u.NewObj("enabled", enabled))
}

// SetRoute：setRoute(role, binding | null)
func (s *Service) SetRoute(role any, binding any) (*u.Obj, error) {
	if pid := prop(binding, "providerId"); truthy(pid) {
		if err := s.assertKnown(pid); err != nil {
			return nil, err
		}
	}
	if err := s.opts.Store.SetRoute(role, binding); err != nil {
		return nil, err
	}
	return s.State(), nil
}

// AddKey / RotateKey / RemoveKey / PromoteKey / ResetUsage：直通 store
func (s *Service) AddKey(id string, key, label any) (*u.Obj, error) {
	return s.opts.Store.AddKey(id, key, label)
}
func (s *Service) RotateKey(id string, keyID, key any) (*u.Obj, error) {
	return s.opts.Store.RotateKey(id, keyID, key)
}
func (s *Service) RemoveKey(id string, keyID any) (*u.Obj, error) {
	return s.opts.Store.RemoveKey(id, keyID)
}
func (s *Service) PromoteKey(id string, keyID any) (*u.Obj, error) {
	return s.opts.Store.PromoteKey(id, keyID)
}
func (s *Service) ResetUsage(id any) error { return s.opts.Store.ResetUsage(id) }
