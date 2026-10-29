package usage

// 对应 packages/core/src/usage/types.ts

type UsageSource = string
type UsageVia = string
type Currency = string

// UsageRecord：一次调用（字段与 Node 同名、同可选性）
type UsageRecord struct {
	Key          string   `json:"key"`
	Ts           float64  `json:"ts"`
	Dur          *float64 `json:"dur,omitempty"`
	Source       string   `json:"source"`
	Via          string   `json:"via"`
	Provider     *string  `json:"provider,omitempty"`
	Model        string   `json:"model"`
	Input        float64  `json:"input"`
	Output       float64  `json:"output"`
	CacheRead    float64  `json:"cacheRead"`
	CacheWrite   float64  `json:"cacheWrite"`
	CacheWrite1h *float64 `json:"cacheWrite1h,omitempty"`
	Fast         *bool    `json:"fast,omitempty"`
	Rid          *string  `json:"rid,omitempty"`
	LogKey       *string  `json:"logKey,omitempty"`
	Session      *string  `json:"session,omitempty"`
	Project      *string  `json:"project,omitempty"`
	Est          *bool    `json:"est,omitempty"`
}

type PriceTier struct {
	Size         float64  `json:"size"`
	Input        float64  `json:"input"`
	Output       float64  `json:"output"`
	CacheRead    *float64 `json:"cacheRead,omitempty"`
	CacheWrite   *float64 `json:"cacheWrite,omitempty"`
	CacheWrite1h *float64 `json:"cacheWrite1h,omitempty"`
}

type ModelPrice struct {
	Input        float64     `json:"input"`
	Output       float64     `json:"output"`
	CacheRead    *float64    `json:"cacheRead,omitempty"`
	CacheWrite   *float64    `json:"cacheWrite,omitempty"`
	CacheWrite1h *float64    `json:"cacheWrite1h,omitempty"`
	Tiers        []PriceTier `json:"tiers,omitempty"`
}

// PriceEntry / CustomPrice（CustomPrice 不带 label/note，Go 侧共用一个结构）
type PriceEntry struct {
	Model string `json:"model"`
	ModelPrice
	Label *string `json:"label,omitempty"`
	Note  *string `json:"note,omitempty"`
}

type CustomPrice = PriceEntry

func f64p(v float64) *float64 { return &v }
func strp(v string) *string   { return &v }
func boolp(v bool) *bool      { return &v }
