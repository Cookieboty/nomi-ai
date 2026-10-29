package voice

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"regexp"

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

// BuildForm：与 undici FormData 相同的字段顺序与文件头（boundary 不同：D-B9-6）
func BuildForm(o CloudOpts) (body []byte, contentType string) {
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="file"; filename="speech.wav"`)
	h.Set("Content-Type", "audio/wav")
	fw, _ := w.CreatePart(h)
	_, _ = fw.Write(o.Wav)
	_ = w.WriteField("model", o.Model)
	_ = w.WriteField("response_format", "json")
	if o.Language != "" && o.Language != "auto" {
		_ = w.WriteField("language", o.Language)
	}
	if o.Prompt != "" {
		_ = w.WriteField("prompt", o.Prompt)
	}
	_ = w.Close()
	return b.Bytes(), w.FormDataContentType()
}

// TranscribeOpenAICompat = transcribeOpenAICompat(o)
func TranscribeOpenAICompat(ctx context.Context, o CloudOpts) (string, error) {
	body, ct := BuildForm(o)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, TranscriptionsURL(o.BaseURL), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", ct)
	if o.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+o.APIKey)
	}
	c := o.Client
	if c == nil {
		c = http.DefaultClient
	}
	res, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
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
