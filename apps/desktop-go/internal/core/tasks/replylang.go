package tasks

// replylang.go：后台执行的结果用什么语言写。按用户交代任务时写的文字判断（目标、标题），
// 看不出来时按界面语言。以前提示词写死「用简洁的中文」，英文需求派到后台，结果是中文、再写回英文对话。

import (
	"strings"
	"unicode"

	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// ReplyLanguage：结果用的语言（写进提示词里的名字，给模型看）
func ReplyLanguage(texts ...string) string {
	han, kana, hangul, latin := 0, 0, 0, 0
	for _, s := range texts {
		for _, r := range s {
			switch {
			case unicode.In(r, unicode.Hiragana, unicode.Katakana):
				kana++
			case unicode.Is(unicode.Hangul, r):
				hangul++
			case unicode.Is(unicode.Han, r):
				han++
			case r < 0x250 && unicode.IsLetter(r):
				latin++
			}
		}
	}
	switch {
	case kana > 0:
		return "日本語"
	case hangul > 0 && hangul >= han:
		return "한국어"
	case han >= 2 || (han > 0 && han*3 >= latin):
		// 中文里夹着英文术语、路径、代码名很常见：有几个汉字就按中文
		return "中文"
	case latin > 0:
		return "English"
	}
	if strings.HasPrefix(tr.Locale(), "zh") {
		return "中文"
	}
	return "English"
}
