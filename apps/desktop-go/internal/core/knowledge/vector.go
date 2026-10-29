package knowledge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// Endpoint：OpenAI 兼容的 embeddings / rerank 服务
type Endpoint struct {
	BaseURL string
	APIKey  string
	Model   string
}

func trimBase(u string) string { return strings.TrimRight(u, "/") }

func Cosine(a, b []float32) float64 {
	var dot, na, nb float64
	n := min(len(a), len(b))
	for i := 0; i < n; i++ {
		x, y := float64(a[i]), float64(b[i])
		dot += x * y
		na += x * x
		nb += y * y
	}
	if na != 0 && nb != 0 {
		return dot / math.Sqrt(na*nb)
	}
	return 0
}

// VecToB64 / B64ToVec：Float32（小端）↔ base64
func VecToB64(v []float32) string {
	b := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(f))
	}
	return base64.StdEncoding.EncodeToString(b)
}

func B64ToVec(s string) []float32 {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		b, _ = base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
	}
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[4*i:]))
	}
	return out
}

func post(ctx context.Context, client *http.Client, ep Endpoint, path string, body any) (*http.Response, error) {
	bs, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", trimBase(ep.BaseURL)+path, bytes.NewReader(bs))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	if ep.APIKey != "" {
		req.Header.Set("authorization", "Bearer "+ep.APIKey)
	}
	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(req)
}

func Embed(ctx context.Context, client *http.Client, T i18n.Translate, ep Endpoint, inputs []string) ([][]float32, error) {
	res, err := post(ctx, client, ep, "/embeddings", map[string]any{"model": ep.Model, "input": inputs})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, errors.New(T("electron.common.embeddings-request-failed-http", res.StatusCode))
	}
	var j struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
			Index     float64   `json:"index"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&j); err != nil {
		return nil, err
	}
	if j.Data == nil || len(j.Data) != len(inputs) {
		return nil, errors.New(T("electron.common.embeddings-response-is-malformed"))
	}
	sort.SliceStable(j.Data, func(a, b int) bool { return j.Data[a].Index < j.Data[b].Index })
	out := make([][]float32, len(j.Data))
	for i, d := range j.Data {
		out[i] = d.Embedding
	}
	return out, nil
}

func Rerank(ctx context.Context, client *http.Client, T i18n.Translate, ep Endpoint, query string, docs []string) ([]float64, error) {
	res, err := post(ctx, client, ep, "/rerank", map[string]any{"model": ep.Model, "query": query, "documents": docs, "top_n": len(docs)})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, errors.New(T("electron.common.rerank-request-failed-http", res.StatusCode))
	}
	var j struct {
		Results []struct {
			Index          float64  `json:"index"`
			RelevanceScore *float64 `json:"relevance_score"`
			Score          *float64 `json:"score"`
		} `json:"results"`
	}
	if err := json.NewDecoder(res.Body).Decode(&j); err != nil {
		return nil, err
	}
	if j.Results == nil {
		return nil, errors.New(T("electron.common.rerank-response-is-malformed"))
	}
	scores := make([]float64, len(docs))
	for i := range scores {
		scores[i] = math.Inf(-1)
	}
	for _, r := range j.Results {
		if r.Index >= 0 && r.Index < float64(len(docs)) && r.Index == math.Trunc(r.Index) {
			v := 0.0
			if r.RelevanceScore != nil {
				v = *r.RelevanceScore
			} else if r.Score != nil {
				v = *r.Score
			}
			scores[int(r.Index)] = v
		}
	}
	return scores, nil
}

// RRF：Reciprocal Rank Fusion
func RRF(lists [][]Scored, k float64) []Scored {
	s := newOmap[float64]()
	for _, l := range lists {
		for i, x := range l {
			c, _ := s.Get(x.ID)
			s.Set(x.ID, c+1/(k+float64(i)+1))
		}
	}
	out := []Scored{}
	s.Each(func(id string, v float64) bool { out = append(out, Scored{id, v}); return true })
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out
}
