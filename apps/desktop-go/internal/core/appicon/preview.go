package appicon

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
)

// PNGPreview = nativeImage.createFromPath(p).resize({ width }).toDataURL()：等比缩到 width（面积平均），PNG data URL。
// 读不到 / 解不开时与空 NativeImage 一样给 "data:image/png;base64,"。像素与 Skia 的重采样不逐字节一致（D-SH-2）。
func PNGPreview(path string, width int) string {
	const prefix = "data:image/png;base64,"
	b, err := os.ReadFile(path)
	if err != nil {
		return prefix
	}
	src, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return prefix
	}
	img := Resize(src, width)
	var buf bytes.Buffer
	if png.Encode(&buf, img) != nil {
		return prefix
	}
	return prefix + base64.StdEncoding.EncodeToString(buf.Bytes())
}

// Resize 等比缩放到宽 w（高四舍五入，至少 1）；缩小用面积平均（预乘 alpha），放大用最近邻
func Resize(src image.Image, w int) *image.NRGBA {
	sb := src.Bounds()
	sw, shh := sb.Dx(), sb.Dy()
	if sw == 0 || shh == 0 || w <= 0 {
		return image.NewNRGBA(image.Rect(0, 0, 0, 0))
	}
	h := (shh*w + sw/2) / sw
	if h < 1 {
		h = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	fx, fy := float64(sw)/float64(w), float64(shh)/float64(h)
	for y := 0; y < h; y++ {
		y0, y1 := float64(y)*fy, float64(y+1)*fy
		for x := 0; x < w; x++ {
			x0, x1 := float64(x)*fx, float64(x+1)*fx
			var r, g, b, a, wt float64
			for sy := int(y0); float64(sy) < y1 && sy < shh; sy++ {
				wy := minf(y1, float64(sy+1)) - maxf(y0, float64(sy))
				for sx := int(x0); float64(sx) < x1 && sx < sw; sx++ {
					wx := minf(x1, float64(sx+1)) - maxf(x0, float64(sx))
					c := color.RGBA64Model.Convert(src.At(sb.Min.X+sx, sb.Min.Y+sy)).(color.RGBA64)
					k := float64(wx * wy)
					r += float64(float64(c.R) * k)
					g += float64(float64(c.G) * k)
					b += float64(float64(c.B) * k)
					a += float64(float64(c.A) * k)
					wt += k
				}
			}
			if wt == 0 || a == 0 {
				continue
			}
			dst.SetNRGBA(x, y, color.NRGBA{
				R: uint8(r / a * 255), G: uint8(g / a * 255), B: uint8(b / a * 255), A: uint8(a / wt / 257),
			})
		}
	}
	return dst
}

func minf(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
