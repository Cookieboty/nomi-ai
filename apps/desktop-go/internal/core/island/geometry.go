package island

import (
	_ "embed"
	"math"
	"os"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 灵动岛的几何常量：一条时是一个 64 高的胶囊（44 的图标块 + 行内上下 5 + 岛上下 5）；多条时列表往下长，
// 最多显示 ListRows 行，再多的在列表里滚动
const (
	IslandPadY       = 5
	IslandRowMin     = 54
	NotchRowMin      = 54
	IslandRowMax     = 64
	IslandRowDefault = 54
	IslandGap        = 6
	NotchWidth       = 196
	IslandWidth      = 440
	ListRows         = 4
	// ListMax：列表区最高（4 行 × 52 + 3 个间隔）
	ListMax = 4*52 + 3*6
	// MaxContent：内容最高（列表模式多出的上下 6 + 列表头 + 列表 + 「还有 N 项」）
	MaxContent = 12 + 28 + ListMax + 24
)

//go:embed island.html
var islandPage string

type Size struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type Pad struct {
	Top    float64 `json:"top"`
	Bottom float64 `json:"bottom"`
}
type Margin struct {
	X      float64 `json:"x"`
	Bottom float64 `json:"bottom"`
}

var (
	NotchPad     = Pad{Top: 4, Bottom: 12}
	ShadowMargin = Margin{X: 14, Bottom: 18}
)

// Geometry：灵动岛几何（字段顺序固定，便于逐字比对 JSON）
type Geometry struct {
	Mode          string  `json:"mode"`
	Preset        string  `json:"preset"`
	X             float64 `json:"x"`
	Y             float64 `json:"y"`
	Width         float64 `json:"width"`
	Height        float64 `json:"height"`
	Collapsed     Size    `json:"collapsed"`
	MenuBarHeight float64 `json:"menuBarHeight"`
	Inset         float64 `json:"inset"`
	Pad           Pad     `json:"pad"`
	RowMin        float64 `json:"rowMin"`
	Margin        Margin  `json:"margin"`
}

type WinRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func simulate() bool { return os.Getenv("CD_ISLAND_SIMULATE_NOTCH") == "1" }

// jsRound = Math.round（.5 向 +∞）
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// IslandHeight = islandHeight(g, contentHeight)
func IslandHeight(g Geometry, contentHeight float64) float64 {
	c := contentHeight
	if math.IsNaN(c) || math.IsInf(c, 0) {
		c = IslandRowDefault
	}
	content := math.Min(IslandRowMax, math.Max(g.RowMin, math.Ceil(c)))
	return g.Inset + g.Pad.Top + g.Pad.Bottom + content
}

// ClampIslandHeight = clampIslandHeight(g, measured)
func ClampIslandHeight(g Geometry, measured float64) float64 {
	return IslandHeight(g, measured-g.Inset-g.Pad.Top-g.Pad.Bottom)
}

// IslandWindowRect = islandWindowRect(g, height)
func IslandWindowRect(g Geometry, height float64) WinRect {
	return WinRect{X: g.X - g.Margin.X, Y: g.Y, Width: g.Width + g.Margin.X*2, Height: height + g.Margin.Bottom}
}

// IslandGeometry = islandGeometry(platform, d, pref)
func IslandGeometry(platform string, d Display, pref string, sizes ...string) Geometry {
	preset := "large"
	width, row := float64(IslandWidth), float64(IslandRowDefault)
	if len(sizes) > 0 {
		switch sizes[0] {
		case "medium":
			preset, width, row = "medium", 360, 46
		case "small":
			preset, width, row = "small", 300, 38
		}
	}
	menuBar := 37.0
	if !simulate() {
		menuBar = math.Max(0, d.WorkArea.Y-d.Bounds.Y)
	}
	notch := pref == "auto" && HasNotch(platform, d)
	g := Geometry{Mode: "pill", Preset: preset, MenuBarHeight: menuBar, Width: math.Min(width, d.Bounds.Width-32)}
	g.X = jsRound(d.Bounds.X + float64((d.Bounds.Width-g.Width)/2))
	if notch {
		g.Mode, g.Inset, g.Pad, g.RowMin = "notch", menuBar, NotchPad, NotchRowMin
		g.Y = d.Bounds.Y
		g.Collapsed = Size{NotchWidth, menuBar}
	} else {
		g.Pad, g.RowMin = Pad{IslandPadY, IslandPadY}, IslandRowMin
		g.Y = d.WorkArea.Y + IslandGap
		g.Collapsed = Size{160, 36}
		g.Margin = ShadowMargin
	}
	g.RowMin = row
	g.Height = IslandHeight(g, row)
	return g
}

// ContentHeight：页面报来的岛高度（nomi:island:size）收进合理范围：不低于一条的高度，不高于列表的上限
func ContentHeight(g Geometry, h float64) float64 {
	if math.IsNaN(h) || math.IsInf(h, 0) {
		return g.Height
	}
	return math.Min(g.Inset+g.Pad.Top+g.Pad.Bottom+MaxContent, math.Max(g.Height, math.Ceil(h)))
}

// IslandHTML：灵动岛页面（island.html，替换几何数值哨兵）
func IslandHTML(g Geometry) string {
	n := util.FormatNumber
	return strings.NewReplacer(
		"⟦preset⟧", g.Preset, "⟦mode⟧", g.Mode, "⟦width⟧", n(g.Width), "⟦cw⟧", n(g.Collapsed.Width), "⟦ch⟧", n(g.Collapsed.Height),
		"⟦inset⟧", n(g.Inset), "⟦padT⟧", n(g.Pad.Top), "⟦padB⟧", n(g.Pad.Bottom), "⟦mx⟧", n(g.Margin.X),
		"⟦listMax⟧", n(ListMax), "⟦listRows⟧", n(ListRows),
	).Replace(islandPage)
}
