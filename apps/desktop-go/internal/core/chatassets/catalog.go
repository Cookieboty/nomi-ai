package chatassets

// 素材的分类、标签与真实尺寸。
//   - 分类固定几种（Categories）：生成时先按提示词的关键词分（ClassifyByKeywords），有提示词的再在后台让辅助模型
//     分一次（Deps.Classify；用户没手动改过时才覆盖）；用户可以随时改（Update，记 CategoryBy = user）。
//   - 标签：用户自己加，最多 MaxTags 个、每个最长 MaxTagLen 个字。
//   - 尺寸：读文件头（png / jpeg / gif 用标准库，webp 自己读 RIFF 头），记进 assets.json。

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"slices"
	"strings"
)

// Categories：素材库的分类（视图的分类标签按这个顺序）；other = 其他
var Categories = []string{"illustration", "people", "landscape", "animal", "other"}

const (
	MaxTags   = 12
	MaxTagLen = 20
)

// ErrUnknownAsset：素材库里没有这个文件；ErrBadCategory：不认识的分类
var (
	ErrUnknownAsset = errors.New("ASSET_NOT_FOUND")
	ErrBadCategory  = errors.New("ASSET_BAD_CATEGORY")
)

func isCategory(c string) bool { return slices.Contains(Categories, c) }

// 关键词：按顺序先命中先算（动物、人物比风景具体；「插画」是画风，最后看）。中英文都认，比较时转小写
var keywordRules = []struct {
	cat   string
	words []string
}{
	{"animal", []string{"猫", "狗", "鸟", "鱼", "兔", "熊", "狐", "狼", "马", "虎", "狮", "鹿", "熊猫", "宠物", "动物", "小猫", "小狗",
		"cat", "kitten", "dog", "puppy", "bird", "fish", "rabbit", "bear", "fox", "wolf", "horse", "tiger", "lion", "deer", "panda", "pet", "animal"}},
	{"people", []string{"人", "女孩", "男孩", "女人", "男人", "少女", "少年", "孩子", "肖像", "人像", "自拍", "头像", "角色", "美女", "老人",
		"girl", "boy", "woman", "man", "person", "people", "portrait", "selfie", "child", "kid", "face", "character"}},
	{"landscape", []string{"风景", "山", "大海", "海边", "海洋", "海浪", "湖", "河", "森林", "草原", "天空", "日落", "日出", "城市", "街道", "沙滩", "雪", "瀑布", "星空", "风光",
		"landscape", "mountain", "sea", "ocean", "lake", "river", "forest", "sky", "sunset", "sunrise", "city", "street", "beach", "snow", "waterfall", "scenery"}},
	{"illustration", []string{"插画", "漫画", "卡通", "动漫", "手绘", "水彩", "油画", "像素", "矢量", "图标", "海报", "logo", "二次元",
		"illustration", "comic", "manga", "cartoon", "anime", "drawing", "watercolor", "painting", "pixel", "vector", "icon", "poster"}},
}

// ClassifyInstruction：给辅助模型的说明（只回一个英文分类名）
const ClassifyInstruction = "Classify the image described by the user's prompt into exactly one category: " +
	"illustration (drawn / painted / cartoon / poster style), people (a person is the subject), " +
	"landscape (scenery, nature, city views), animal (an animal is the subject), other. " +
	"Reply with the category word only."

// ClassifyByKeywords：按提示词里的关键词分类；没有提示词或都没命中时是 other
func ClassifyByKeywords(prompt string) string {
	p := strings.ToLower(prompt)
	if strings.TrimSpace(p) == "" {
		return "other"
	}
	for _, r := range keywordRules {
		for _, w := range r.words {
			if hasWord(p, w) {
				return r.cat
			}
		}
	}
	return "other"
}

// hasWord：中文关键词按子串找；英文关键词要整词（前后不是字母），免得 delicate 里的 cat、woman 里的 man 算进来。
// 复数 / 所有格（cats、cat's）也算
func hasWord(text, w string) bool {
	if w == "" || w[0] >= 0x80 {
		return strings.Contains(text, w)
	}
	for from := 0; ; {
		i := strings.Index(text[from:], w)
		if i < 0 {
			return false
		}
		i += from
		end := i + len(w)
		before := i == 0 || !isLetter(text[i-1])
		after := end == len(text) || !isLetter(text[end]) ||
			text[end] == 's' && (end+1 == len(text) || !isLetter(text[end+1]))
		if before && after {
			return true
		}
		from = i + 1
	}
}

func isLetter(b byte) bool { return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' }

// ParseCategory：辅助模型的回复 → 分类（回复里出现的第一个分类名；中文名也认）；认不出时 ""
func ParseCategory(reply string) string {
	r := strings.ToLower(reply)
	zh := map[string]string{"插画": "illustration", "人物": "people", "风景": "landscape", "动物": "animal", "其他": "other"}
	best, at := "", len(r)+1
	for _, c := range Categories {
		if i := strings.Index(r, c); i >= 0 && i < at {
			best, at = c, i
		}
	}
	for w, c := range zh {
		if i := strings.Index(r, w); i >= 0 && i < at {
			best, at = c, i
		}
	}
	return best
}

// classifyAsync：辅助模型分类（后台）；用户在这期间改过就不覆盖
func (l *Library) classifyAsync(file, prompt string) {
	c, err := l.d.Classify(prompt)
	if err != nil || !isCategory(c) {
		return
	}
	l.mu.Lock()
	m := l.readMeta()
	mt, ok := m[file]
	if !ok || mt.CategoryBy == "user" || mt.Category == c && mt.CategoryBy == "ai" {
		l.mu.Unlock()
		return
	}
	mt.Category, mt.CategoryBy = c, "ai"
	m[file] = mt
	l.writeMeta(m)
	l.mu.Unlock()
	if l.d.OnChanged != nil {
		l.d.OnChanged()
	}
}

// Patch：用户改分类 / 标签（nil = 不改）
type Patch struct {
	Category *string  `json:"category,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	SetTags  bool     `json:"-"`
}

// CleanTags：去空白、去重、截断长度与个数
func CleanTags(in []string) []string {
	out := []string{}
	for _, t := range in {
		t = strings.Join(strings.Fields(t), " ")
		if r := []rune(t); len(r) > MaxTagLen {
			t = string(r[:MaxTagLen])
		}
		if t == "" || slices.ContainsFunc(out, func(x string) bool { return strings.EqualFold(x, t) }) {
			continue
		}
		out = append(out, t)
		if len(out) == MaxTags {
			break
		}
	}
	return out
}

// Update：改一张图的分类 / 标签，返回改后的条目
func (l *Library) Update(file string, p Patch) (Item, error) {
	if SourceOf(file) == "" {
		return Item{}, ErrUnknownAsset
	}
	if _, err := os.Stat(l.pathOf(file)); err != nil {
		return Item{}, ErrUnknownAsset
	}
	if p.Category != nil && !isCategory(*p.Category) {
		return Item{}, ErrBadCategory
	}
	l.mu.Lock()
	m := l.readMeta()
	mt := m[file]
	if p.Category != nil {
		mt.Category, mt.CategoryBy = *p.Category, "user"
	}
	if p.SetTags {
		mt.Tags = CleanTags(p.Tags)
	}
	m[file] = mt
	l.writeMeta(m)
	l.mu.Unlock()
	if l.d.OnChanged != nil {
		l.d.OnChanged()
	}
	for _, it := range l.List() {
		if it.File == file {
			return it, nil
		}
	}
	return Item{}, ErrUnknownAsset
}

// imageSize：读文件头得到像素尺寸
func imageSize(path string) (int, int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	head := make([]byte, 64)
	n, _ := io.ReadFull(f, head)
	head = head[:n]
	if w, h, ok := webpSize(head); ok {
		return w, h, true
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return 0, 0, false
	}
	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return 0, 0, false
	}
	return cfg.Width, cfg.Height, true
}

// webpSize：RIFF....WEBP 后面的 VP8 / VP8L / VP8X 块头
func webpSize(b []byte) (int, int, bool) {
	if len(b) < 30 || !bytes.Equal(b[0:4], []byte("RIFF")) || !bytes.Equal(b[8:12], []byte("WEBP")) {
		return 0, 0, false
	}
	switch string(b[12:16]) {
	case "VP8 ":
		// 关键帧：起始码 9d 01 2a 后面是 14 位宽、14 位高
		if b[23] != 0x9d || b[24] != 0x01 || b[25] != 0x2a {
			return 0, 0, false
		}
		w := int(binary.LittleEndian.Uint16(b[26:28]) & 0x3fff)
		h := int(binary.LittleEndian.Uint16(b[28:30]) & 0x3fff)
		return w, h, w > 0 && h > 0
	case "VP8L":
		if b[20] != 0x2f {
			return 0, 0, false
		}
		v := binary.LittleEndian.Uint32(b[21:25])
		return int(v&0x3fff) + 1, int((v>>14)&0x3fff) + 1, true
	case "VP8X":
		w := int(b[24]) | int(b[25])<<8 | int(b[26])<<16
		h := int(b[27]) | int(b[28])<<8 | int(b[29])<<16
		return w + 1, h + 1, true
	}
	return 0, 0, false
}
