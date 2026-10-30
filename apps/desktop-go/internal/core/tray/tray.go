// Package tray = apps/desktop-electron/src/core/TrayManager.ts 的菜单部分：一键切换 Nomi 对话的模型、打开对话 /
// 模型设置 / 桌面能力、角色动作、互动设置、退出。菜单由统一网关状态生成，变化（模型 / 语言 / 角色）即重建。
// 只产出菜单模型（shell.MenuItem），渲染在外壳。
package tray

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// View = GatewayStateView 里菜单用到的部分（providers / clients.nomi.models.main / recentNomi）
type View struct {
	Providers []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Enabled bool   `json:"enabled"`
		Models  []struct {
			ID          string `json:"id"`
			Label       string `json:"label"`
			Enabled     bool   `json:"enabled"`
			ToolCalling *bool  `json:"toolCalling"`
		} `json:"models"`
	} `json:"providers"`
	Clients struct {
		Nomi *struct {
			Models struct {
				Main string `json:"main"`
			} `json:"models"`
		} `json:"nomi"`
	} `json:"clients"`
	RecentNomi []string `json:"recentNomi"`
}

// ParseView：网关 state() 的 JSON → View（state 是有序对象，先序列化）
func ParseView(state any) View {
	var v View
	b, err := json.Marshal(state)
	if err == nil {
		_ = json.Unmarshal(b, &v)
	}
	return v
}

// Entry = ProviderMenuEntry（网关条目：点了之后设为 Nomi 对话 main 的 `供应商/模型`）
type Entry struct {
	ID      string
	Label   string
	Checked bool
	Ref     string
}

// Translate = i18n t
type Translate func(key string, args ...any) string

var envName = regexp.MustCompile(`^(.*)（环境变量）$`)

// providerName：预设名与「（环境变量）」后缀按当前语言翻译，用户自定义名字原样保留
func providerName(name string, t Translate) string {
	if m := envName.FindStringSubmatch(name); m != nil {
		return t("electron.common.env", providerName(m[1], t))
	}
	return t(name)
}

// GatewayMenuEntries = gatewayMenuEntries：最近用过的 5 个模型（当前的排第一，打勾）；还没有使用记录时每个启用的
// 供应商一项（它第一个能调工具的模型，否则第一个启用的模型）
func GatewayMenuEntries(v View, t Translate) []Entry {
	main := ""
	if v.Clients.Nomi != nil {
		main = v.Clients.Nomi.Models.Main
	}
	type hit struct{ provider, model, label string }
	find := func(ref string) *hit {
		i := strings.Index(ref, "/")
		if i <= 0 {
			return nil
		}
		for _, p := range v.Providers {
			if !p.Enabled || p.ID != ref[:i] {
				continue
			}
			for _, m := range p.Models {
				if m.Enabled && m.ID == ref[i+1:] {
					label := m.Label
					if label == "" {
						label = m.ID
					}
					return &hit{p.ID, m.ID, t("{0} · {1}", providerName(p.Name, t), label)}
				}
			}
		}
		return nil
	}
	var out []Entry
	seen := map[string]bool{}
	for _, ref := range append([]string{main}, v.RecentNomi...) {
		if ref == "" || seen[ref] {
			continue
		}
		seen[ref] = true
		if h := find(ref); h != nil && len(out) < 5 {
			out = append(out, Entry{ID: h.provider, Label: h.label, Checked: ref == main, Ref: ref})
		}
	}
	if len(out) > 0 {
		return out
	}
	for _, p := range v.Providers {
		if !p.Enabled {
			continue
		}
		model := ""
		for _, m := range p.Models {
			if m.Enabled && (m.ToolCalling == nil || *m.ToolCalling) {
				model = m.ID
				break
			}
		}
		if model == "" {
			for _, m := range p.Models {
				if m.Enabled {
					model = m.ID
					break
				}
			}
		}
		if model != "" {
			out = append(out, Entry{ID: p.ID, Label: t("{0} · {1}", providerName(p.Name, t), model), Ref: p.ID + "/" + model})
		}
	}
	return out
}

// Motions = TRAY_MOTIONS：语义手势（§10.5）→ 菜单文案
var Motions = [][2]string{
	{"wave", "electron.common.wave"},
	{"nod", "electron.common.nod"},
	{"shakeHead", "electron.common.shake-head"},
	{"bow", "electron.common.bow"},
	{"think", "electron.common.chin-rest-thinking"},
	{"heart", "electron.common.heart-gesture"},
	{"cheer", "electron.common.cheer-fist-pump"},
	{"thumbsUp", "electron.common.thumbs-up"},
	{"peace", "electron.common.peace-sign"},
	{"celebrate", "electron.common.celebrate"},
	{"clap", "electron.common.clap"},
	{"shy", "electron.common.shy"},
	{"apologize", "electron.common.apologise"},
	{"surprise", "electron.common.surprised"},
	{"yawn", "electron.common.yawn"},
	{"stretch", "electron.common.stretch"},
	{"goodnight", "electron.common.good-night"},
}

// Deps = TrayManagerOptions
type Deps struct {
	T     Translate
	TName func(key, name string, rest ...any) string
	// State：网关 state()；Select：设为 Nomi 对话 main（setAssignment('nomi', { models: { main } })）
	State  func() any
	Select func(ref string)
	// Locked：Nomi 供应商锁定了对话模型（ProviderService overrideId）
	Locked func() bool
	// CharacterName：当前角色简称（人设，当前界面语言）
	CharacterName                                 func() string
	OpenChat, OpenProviderPanel, OpenDesktopPanel func()
	Gesture                                       func(name string)
	OpenInteraction                               func()
	Quit                                          func()
}

func call(fn func()) func() {
	return func() {
		if fn != nil {
			fn()
		}
	}
}

// Menu = TrayManager.rebuild 的菜单模板
func Menu(d Deps) []shell.MenuItem {
	t := d.T
	locked := d.Locked != nil && d.Locked()
	var view View
	if d.State != nil {
		view = ParseView(d.State())
	}
	items := []shell.MenuItem{
		{Label: t("electron.common.open-ai-chat"), Click: call(d.OpenChat)},
		{Separator: true},
	}
	head := t("electron.common.chat-model")
	if locked {
		head = t("electron.common.chat-model-locked-by-nomi-provider")
	}
	items = append(items, shell.MenuItem{Label: head, Disabled: true})
	for _, e := range GatewayMenuEntries(view, t) {
		ref := e.Ref
		items = append(items, shell.MenuItem{Label: e.Label, Radio: true, Checked: e.Checked, Disabled: locked,
			Click: func() {
				if d.Select != nil {
					d.Select(ref)
				}
			}})
	}
	name := ""
	if d.CharacterName != nil {
		name = d.CharacterName()
	}
	if name == "" {
		name = t("ui.mascot-theme.the-mascot")
	}
	var motions []shell.MenuItem
	for _, m := range Motions {
		gesture := m[0]
		motions = append(motions, shell.MenuItem{Label: t(m[1]), Click: func() {
			if d.Gesture != nil {
				d.Gesture(gesture)
			}
		}})
	}
	items = append(items,
		shell.MenuItem{Label: t("electron.common.model-settings"), Click: call(d.OpenProviderPanel)},
		shell.MenuItem{Label: t("electron.common.desktop-abilities-file-grants-activity-log"), Click: call(d.OpenDesktopPanel)},
		shell.MenuItem{Separator: true},
		shell.MenuItem{Label: d.TName("electron.common.nomi-motions", name), Submenu: motions},
		shell.MenuItem{Label: t("electron.common.interaction-settings-click-through-gravity-stroll"), Click: call(d.OpenInteraction)},
		shell.MenuItem{Separator: true},
		shell.MenuItem{Label: t("electron.common.quit"), Click: call(d.Quit)},
	)
	return items
}
