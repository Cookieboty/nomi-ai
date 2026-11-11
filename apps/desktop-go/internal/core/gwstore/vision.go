package gwstore

// Computer Use 的视觉兜底：列出能看图的模型，带一张截图问一次（经本地网关，四种协议由网关互转）。

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// VisionModel：一个能看图的模型（ref = <供应商 id>/<模型 id>）
type VisionModel struct {
	Ref      string `json:"ref"`
	Label    string `json:"label"`
	Provider string `json:"provider"`
}

// VisionModels：启用的供应商里标了能看图的模型（不要求支持工具调用：GUI 定位模型常常不支持）
func (s *Service) VisionModels() []VisionModel {
	out := []VisionModel{}
	for _, p := range s.allProviders() {
		if !u.Truthy(p.Get("enabled")) {
			continue
		}
		pid, _ := p.Get("id").(string)
		pname, _ := p.Get("name").(string)
		ms, _ := p.Get("models").([]any)
		for _, mv := range ms {
			m := asObj(mv)
			if m == nil || !u.Truthy(m.Get("enabled")) {
				continue
			}
			mid, _ := m.Get("id").(string)
			ref := pid + "/" + mid
			meta := s.ModelMetaOf(ref, nil)
			if meta == nil || meta.Vision == nil || !*meta.Vision {
				continue
			}
			label, _ := m.Get("label").(string)
			if label == "" {
				label = mid
			}
			out = append(out, VisionModel{Ref: ref, Label: label, Provider: pname})
		}
	}
	return out
}

// VisionRoute：ref 路由到的上游（谁会收到截图）；nil = 路由不到
func (s *Service) VisionRoute(ref string) *HelperRoute {
	if s.address("nomi", false) == nil || ref == "" {
		return nil
	}
	cfg := s.gatewayConfig(s.Store.View())
	picked := route.PreferredWire(cfg, "nomi", ref)
	if picked == nil || len(picked.Upstreams) == 0 {
		return nil
	}
	up := picked.Upstreams[0]
	return &HelperRoute{Model: picked.PublicModel, Receiver: HelperReceiver{ID: up.ProviderID, Name: up.Name, Local: privateURL(up.URL)}}
}

// VisionComplete：带一张 PNG 问一次（OpenAI chat/completions 形状：文字 + image_url data URL）
func (s *Service) VisionComplete(ctx context.Context, model, prompt string, png []byte) (string, error) {
	ep := s.address("nomi", false)
	if ep == nil {
		return "", errors.New(i18n.T("electron.common.ai-service-not-ready"))
	}
	img := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	content := []any{
		u.NewObj("type", "text", "text", prompt),
		u.NewObj("type", "image_url", "image_url", u.NewObj("url", img)),
	}
	body := u.Stringify(u.NewObj("model", model, "messages", []any{u.NewObj("role", "user", "content", content)},
		"stream", false, "temperature", float64(0)))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.URL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("authorization", "Bearer "+ep.Token)
	req.Header.Set("content-type", "application/json")
	res, err := s.rt.httpc.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return "", err
	}
	text := string(bytes.TrimPrefix(jsText(raw), []byte("\xef\xbb\xbf")))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", errors.New(strconv.Itoa(res.StatusCode) + " " + u.UTF16Slice0(text, 500))
	}
	j, err := u.ParseString(text)
	if err != nil {
		return "", errors.New("vision model returned non-JSON")
	}
	jo, _ := j.(*u.Obj)
	if jo == nil {
		return "", nil
	}
	choices, _ := jo.Get("choices").([]any)
	if len(choices) == 0 {
		return "", nil
	}
	fo, _ := choices[0].(*u.Obj)
	if fo == nil {
		return "", nil
	}
	msg, _ := fo.Get("message").(*u.Obj)
	if msg == nil {
		return "", nil
	}
	c, _ := msg.Get("content").(string)
	return c, nil
}
