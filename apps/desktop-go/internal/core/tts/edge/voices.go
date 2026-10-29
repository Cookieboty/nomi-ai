package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Voice = TTSVoice（Gender / Name 为空 = undefined）
type Voice struct {
	ShortName string `json:"shortName"`
	Locale    string `json:"locale"`
	Gender    string `json:"gender,omitempty"`
	Name      string `json:"name,omitempty"`
}

// BuiltinZhVoices = BUILTIN_ZH_VOICES
var BuiltinZhVoices = []Voice{
	{"zh-CN-XiaoyiNeural", "zh-CN", "Female", ""},
	{"zh-CN-XiaoxiaoNeural", "zh-CN", "Female", ""},
	{"zh-CN-YunxiNeural", "zh-CN", "Male", ""},
	{"zh-CN-YunjianNeural", "zh-CN", "Male", ""},
	{"zh-CN-YunyangNeural", "zh-CN", "Male", ""},
	{"zh-CN-YunxiaNeural", "zh-CN", "Male", ""},
	{"zh-TW-HsiaoChenNeural", "zh-TW", "Female", ""},
	{"zh-HK-HiuGaaiNeural", "zh-HK", "Female", ""},
}

// VoiceList = VoiceList
type VoiceList struct {
	Voices []Voice `json:"voices"`
	Source string  `json:"source"`
}

// Fetcher 发 GET（测试可替换）；返回状态码与正文
type Fetcher func(ctx context.Context, url string, headers Header) (int, []byte, error)

// DefaultFetcher：net/http；undici 的 Accept-Encoding 默认值与解压见 D-B9-6
func DefaultFetcher(ctx context.Context, url string, headers Header) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return 0, nil, err
	}
	for _, kv := range headers {
		req.Header[kv[0]] = []string{kv[1]}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return res.StatusCode, b, err
}

var (
	cacheMu sync.Mutex
	cache   []Voice
	zhRe    = regexp.MustCompile(`^zh-`)
)

// ClearVoiceCacheForTests = clearVoiceCacheForTests()
func ClearVoiceCacheForTests() {
	cacheMu.Lock()
	cache = nil
	cacheMu.Unlock()
}

// ParseVoices 是 listChineseVoices 的过滤 / 映射 / 排序部分（res.json() 之后）
func ParseVoices(body []byte) ([]Voice, error) {
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil, errors.New("unexpected voice list")
	}
	out := []Voice{}
	for _, x := range arr {
		v, _ := x.(map[string]any)
		sn, ok := v["ShortName"].(string)
		if !ok || !zhRe.MatchString(sn) || !VoiceNameRe.MatchString(sn) {
			continue
		}
		vo := Voice{ShortName: sn}
		if l, ok := v["Locale"].(string); ok {
			vo.Locale = l
		} else {
			vo.Locale = util.UTF16Slice0(sn, 5)
		}
		vo.Gender, _ = v["Gender"].(string)
		vo.Name, _ = v["FriendlyName"].(string)
		out = append(out, vo)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if c := models.LocaleCompare(out[i].Locale, out[j].Locale); c != 0 {
			return c < 0
		}
		return models.LocaleCompare(out[i].ShortName, out[j].ShortName) < 0
	})
	if len(out) == 0 {
		return nil, errors.New("no chinese voices")
	}
	return out, nil
}

// ListChineseVoices = listChineseVoices(fetchImpl, timeoutMs)
func ListChineseVoices(f Fetcher, timeout time.Duration) VoiceList {
	cacheMu.Lock()
	c := cache
	cacheMu.Unlock()
	if c != nil {
		return VoiceList{Voices: c, Source: "online"}
	}
	if f == nil {
		f = DefaultFetcher
	}
	if timeout == 0 {
		timeout = 8 * time.Second
	}
	voices, err := func() ([]Voice, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		st, body, err := f(ctx, VoicesURL(NowSeconds()), HTTPHeaders())
		if err != nil {
			return nil, err
		}
		if st < 200 || st > 299 {
			return nil, fmt.Errorf("HTTP %d", st)
		}
		return ParseVoices(body)
	}()
	if err != nil {
		return VoiceList{Voices: append([]Voice(nil), BuiltinZhVoices...), Source: "builtin"}
	}
	cacheMu.Lock()
	cache = voices
	cacheMu.Unlock()
	return VoiceList{Voices: voices, Source: "online"}
}
