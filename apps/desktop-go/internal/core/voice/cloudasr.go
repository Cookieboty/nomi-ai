package voice

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"strings"

	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var trailingSlashes = regexp.MustCompile(`/+$`)

// TranscriptionsURL = transcriptionsURL(baseURL)
func TranscriptionsURL(baseURL string) string {
	return trailingSlashes.ReplaceAllString(baseURL, "") + "/audio/transcriptions"
}

// CloudOpts = transcribeOpenAICompat 的参数
type CloudOpts struct {
	BaseURL  string
	APIKey   string
	Model    string
	Wav      []byte
	Language string
	Prompt   string
	Client   *http.Client
	T        func(key string, args ...any) string
}

// undiciBoundary = undici extractBody：`----formdata-undici-0${`${random(1e11)}`.padStart(11, '0')}`
func undiciBoundary() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1e11))
	return fmt.Sprintf("----formdata-undici-0%011d", n.Int64())
}

// BuildForm = undici 对 FormData 的序列化（字段顺序、头、结尾 `--boundary--` 不带 CRLF）
func BuildForm(o CloudOpts) (body []byte, contentType string) {
	return buildFormWith(o, undiciBoundary())
}

func buildFormWith(o CloudOpts, boundary string) ([]byte, string) {
	var b bytes.Buffer
	prefix := "--" + boundary + "\r\nContent-Disposition: form-data"
	field := func(name, value string) {
		b.WriteString(prefix + `; name="` + name + "\"\r\n\r\n" + strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"), "\n", "\r\n") + "\r\n")
	}
	b.WriteString(prefix + `; name="file"; filename="speech.wav"` + "\r\nContent-Type: audio/wav\r\n\r\n")
	b.Write(o.Wav)
	b.WriteString("\r\n")
	field("model", o.Model)
	field("response_format", "json")
	if o.Language != "" && o.Language != "auto" {
		field("language", o.Language)
	}
	if o.Prompt != "" {
		field("prompt", o.Prompt)
	}
	b.WriteString("--" + boundary + "--")
	return b.Bytes(), "multipart/form-data; boundary=" + boundary
}

// cloudClient：Node 全局 fetch 不读代理环境变量、不走 h2；压缩协商交给 undici 规则（DisableCompression）
var cloudClient = &http.Client{Transport: &http.Transport{DisableCompression: true}}

// TranscribeOpenAICompat = transcribeOpenAICompat(o)（全局 fetch：undici 默认请求头，user-agent 为 node）
func TranscribeOpenAICompat(ctx context.Context, o CloudOpts) (string, error) {
	body, ct := BuildForm(o)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, TranscriptionsURL(o.BaseURL), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header = http.Header{}
	if o.APIKey != "" {
		req.Header["Authorization"] = []string{"Bearer " + o.APIKey}
	}
	req.Header["content-type"] = []string{ct}
	req.Header["User-Agent"] = []string{"node"} // Node 全局 fetch 的 UA；用规范名避免 net/http 再补 Go-http-client
	gnet.ApplyUndiciRequestDefaults(req)
	c := o.Client
	if c == nil {
		c = cloudClient
	}
	res, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if err := gnet.DecodeUndiciResponse(req.Method, res); err != nil {
		return "", err
	}
	rb, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	text := string(bytes.ToValidUTF8(rb, []byte("\uFFFD")))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", errors.New(o.T("electron.common.recognition-service-returned", res.StatusCode, util.UTF16Slice0(text, 200)))
	}
	return ParseTranscription(text), nil
}

// ParseTranscription：try { (JSON.parse(body).text ?? ”).trim() } catch { body.trim() }
func ParseTranscription(body string) string {
	v, err := util.Parse([]byte(body))
	if err != nil || v == nil {
		return util.JSTrim(body) // 解析失败 / null.text 抛错
	}
	o, ok := v.(*util.Obj)
	if !ok {
		return "" // 数组 / 数字 / 字符串：.text 为 undefined
	}
	switch t := o.Get("text").(type) {
	case string:
		return util.JSTrim(t)
	case nil, util.JSUndefined:
		return ""
	}
	return util.JSTrim(body) // 非字符串 .trim() 抛 TypeError
}
