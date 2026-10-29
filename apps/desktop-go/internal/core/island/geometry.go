package island

import (
	"math"
	"os"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 常量与 packages/host-electron/src/island/geometry.ts 一致
const (
	IslandPadY       = 11
	IslandRowMin     = 36
	NotchRowMin      = 18
	IslandRowMax     = 64
	IslandRowDefault = 38
	IslandGap        = 5
	NotchWidth       = 196
)

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

// Geometry = IslandGeometry（字段顺序与 Node 对象一致，便于逐字比对 JSON）
type Geometry struct {
	Mode          string  `json:"mode"`
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
func IslandGeometry(platform string, d Display, pref string) Geometry {
	menuBar := 37.0
	if !simulate() {
		menuBar = math.Max(0, d.WorkArea.Y-d.Bounds.Y)
	}
	notch := pref == "auto" && HasNotch(platform, d)
	g := Geometry{Mode: "pill", MenuBarHeight: menuBar, Width: math.Min(400, d.Bounds.Width-32)}
	g.X = jsRound(d.Bounds.X + (d.Bounds.Width-g.Width)/2)
	if notch {
		g.Mode, g.Inset, g.Pad, g.RowMin = "notch", menuBar, NotchPad, NotchRowMin
		g.Y = d.Bounds.Y
		g.Collapsed = Size{NotchWidth, menuBar}
	} else {
		g.Pad, g.RowMin = Pad{IslandPadY, IslandPadY}, IslandRowMin
		g.Y = d.WorkArea.Y + IslandGap
		g.Collapsed = Size{132, 30}
		g.Margin = ShadowMargin
	}
	g.Height = IslandHeight(g, IslandRowDefault)
	return g
}

// IslandHTML = islandHtml(g)：生成的逐字模板（islandpage_tpl.go）替换数值哨兵
func IslandHTML(g Geometry) string {
	n := util.FormatNumber
	return strings.NewReplacer(
		"⟦base⟧", n(g.Inset+g.Pad.Top+g.Pad.Bottom),
		"⟦width⟧", n(g.Width), "⟦height⟧", n(g.Height), "⟦cw⟧", n(g.Collapsed.Width), "⟦ch⟧", n(g.Collapsed.Height),
		"⟦inset⟧", n(g.Inset), "⟦padT⟧", n(g.Pad.Top), "⟦padB⟧", n(g.Pad.Bottom), "⟦mx⟧", n(g.Margin.X),
		"⟦rowMin⟧", n(g.RowMin),
	).Replace(islandPageTpl[g.Mode])
}
