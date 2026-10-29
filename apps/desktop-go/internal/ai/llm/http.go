package llm

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Response is the fetch Response handed to response handlers.
type Response struct {
	Status            int
	StatusText        string
	Headers           map[string]string
	Body              io.ReadCloser
	URL               string
	RequestBodyValues any
	ctx               context.Context
}

// FailedResponseHandler builds the APICallError for a non-2xx response.
type FailedResponseHandler func(r *Response) (*APICallError, error)

// PostJSONArgs is postJsonToApi's input (handlers applied by the caller).
type PostJSONArgs struct {
	URL     string
	Headers []Header
	Body    any // JSON value; serialized with JSON.stringify semantics
	Failed  FailedResponseHandler
	Client  *http.Client
}

// PostJSON is postJsonToApi up to the successful-response handler: it returns
// the 2xx response, or the mapped error (handleFetchError / failed handler).
// The returned request JSON is `body.content`.
func PostJSON(ctx context.Context, a PostJSONArgs) (*Response, string, error) {
	content := util.Stringify(a.Body)
	hs := CombineHeaders([]Header{H("Content-Type", "application/json")}, a.Headers)
	hs = WithUserAgentSuffix(hs, "ai-sdk-provider-utils/"+ProviderUtilsVersion, RuntimeUserAgent)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.URL, bytes.NewReader([]byte(content)))
	if err != nil {
		return nil, content, &APICallError{Message: "Cannot connect to API: " + err.Error(), URL: a.URL, RequestBodyValues: a.Body, IsRetryable: true, Cause: err}
	}
	for _, h := range hs {
		req.Header[http.CanonicalHeaderKey(h.Name)] = []string{h.Value}
	}
	if _, ok := req.Header["User-Agent"]; !ok {
		req.Header["User-Agent"] = []string{""}
	}
	client := a.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, content, FetchError(ctx, err, a.URL, a.Body)
	}
	r := &Response{Status: res.StatusCode, StatusText: statusText(res), Headers: ExtractResponseHeaders(res.Header),
		Body: res.Body, URL: a.URL, RequestBodyValues: a.Body, ctx: ctx}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		defer res.Body.Close()
		apiErr, herr := a.Failed(r)
		if herr != nil {
			if IsAbortError(herr) {
				return nil, content, herr
			}
			var ae *APICallError
			if errors.As(herr, &ae) && ae == herr {
				return nil, content, herr
			}
			return nil, content, &APICallError{Message: "Failed to process error response", Cause: herr,
				StatusCode: r.Status, URL: a.URL, ResponseHeaders: r.Headers, RequestBodyValues: a.Body,
				IsRetryable: DefaultRetryable(r.Status)}
		}
		return nil, content, apiErr
	}
	return r, content, nil
}

func statusText(res *http.Response) string {
	s := res.Status
	if i := strings.IndexByte(s, ' '); i >= 0 {
		return s[i+1:]
	}
	return ""
}

// netCode maps a Go network error onto the undici / libuv error code.
func netCode(err error) string {
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "ECONNREFUSED"
	case errors.Is(err, syscall.ECONNRESET):
		return "ECONNRESET"
	case errors.Is(err, syscall.EPIPE):
		return "EPIPE"
	case errors.Is(err, syscall.ETIMEDOUT):
		return "ETIMEDOUT"
	case errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, io.EOF):
		return "UND_ERR_SOCKET"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "UND_ERR_CONNECT_TIMEOUT"
	}
	var de *net.DNSError
	if errors.As(err, &de) {
		return "ENOTFOUND"
	}
	return ""
}

// FetchError is handleFetchError for a failed fetch() (undici's
// TypeError("fetch failed") with a cause): abort passes through.
func FetchError(ctx context.Context, err error, url string, body any) error {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return ErrAborted()
	}
	code := netCode(err)
	msg := err.Error()
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Addr != nil {
		switch code {
		case "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT":
			msg = oe.Op + " " + code + " " + oe.Addr.String()
		}
	}
	var de *net.DNSError
	if errors.As(err, &de) {
		msg = "getaddrinfo ENOTFOUND " + de.Name
	}
	if code == "UND_ERR_SOCKET" {
		msg = "other side closed"
	}
	return &APICallError{Message: "Cannot connect to API: " + msg, URL: url, RequestBodyValues: body,
		IsRetryable: true, Cause: &NetError{Code: code, Message: msg}}
}

// readText is readResponseBodyAsText (TextDecoder, replacement mode).
func (r *Response) readText() (string, error) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		if r.ctx.Err() != nil {
			return "", ErrAborted()
		}
		return "", err
	}
	var d util.TextDecoder
	return d.Decode(b) + d.Flush(), nil
}

// JSONErrorHandler is createJsonErrorResponseHandler.
func JSONErrorHandler(schema Schema, toMessage func(any) string, isRetryable func(r *Response, data any) *bool) FailedResponseHandler {
	return func(r *Response) (*APICallError, error) {
		text, err := r.readText()
		if err != nil {
			return nil, err
		}
		retry := func(data any) *bool {
			if isRetryable == nil {
				return nil
			}
			return isRetryable(r, data)
		}
		base := APICallError{URL: r.URL, RequestBodyValues: r.RequestBodyValues, StatusCode: r.Status,
			ResponseHeaders: r.Headers, ResponseBody: &text}
		if util.JSTrim(text) == "" {
			base.Message = r.StatusText
			return NewAPICallError(base, retry(nil)), nil
		}
		parsed, perr := ParseJSON(text, schema)
		if perr != nil {
			base.Message = r.StatusText
			return NewAPICallError(base, retry(nil)), nil
		}
		base.Message = toMessage(parsed)
		base.Data = parsed
		return NewAPICallError(base, retry(parsed)), nil
	}
}

// SuccessError wraps a successful-handler failure ("Failed to process successful response").
func (r *Response) SuccessError(err error) error {
	if IsAbortError(err) {
		return err
	}
	if _, ok := err.(*APICallError); ok {
		return err
	}
	return &APICallError{Message: "Failed to process successful response", Cause: err, StatusCode: r.Status,
		URL: r.URL, ResponseHeaders: r.Headers, RequestBodyValues: r.RequestBodyValues, IsRetryable: DefaultRetryable(r.Status)}
}

// JSON is createJsonResponseHandler: (value, rawValue, error).
func (r *Response) JSON(schema Schema) (any, any, error) {
	defer r.Body.Close()
	text, err := r.readText()
	if err != nil {
		return nil, nil, r.streamReadError(err)
	}
	pr := SafeParseJSON(text, schema)
	if !pr.Success {
		return nil, nil, &APICallError{Message: "Invalid JSON response", Cause: pr.Err, StatusCode: r.Status,
			ResponseHeaders: r.Headers, ResponseBody: &text, URL: r.URL, RequestBodyValues: r.RequestBodyValues,
			IsRetryable: DefaultRetryable(r.Status)}
	}
	return pr.Value, pr.RawValue, nil
}

// streamReadError is wrapResponseBodyStream's read-failure mapping.
func (r *Response) streamReadError(err error) error {
	if IsAbortError(err) || r.ctx.Err() != nil {
		return ErrAborted()
	}
	inner := &APICallError{Message: "Failed to process successful response", Cause: err, StatusCode: r.Status,
		URL: r.URL, ResponseHeaders: r.Headers, RequestBodyValues: r.RequestBodyValues, IsRetryable: DefaultRetryable(r.Status)}
	if code := netCode(err); code != "" {
		// findNetworkError hit: same APICallError, isRetryable: true.
		inner.IsRetryable = true
		inner.Cause = &NetError{Code: code, Message: "terminated"}
	}
	return inner
}

// StreamItem is one parsed SSE chunk, or (Err != nil) the stream erroring.
type StreamItem struct {
	ParseResult
	Err error
}

// EventStream is createEventSourceResponseHandler → parseJsonEventStream:
// TextDecoderStream → EventSourceParserStream → skip [DONE] → safeParseJSON.
func (r *Response) EventStream(schema Schema) <-chan StreamItem {
	ch := make(chan StreamItem, 16)
	go func() {
		defer close(ch)
		defer r.Body.Close()
		var dec util.TextDecoder
		var out []StreamItem
		p := &SSEParser{OnEvent: func(m EventSourceMessage) {
			if m.Data == "[DONE]" {
				return
			}
			out = append(out, StreamItem{ParseResult: SafeParseJSON(m.Data, schema)})
		}}
		buf := make([]byte, 32*1024)
		for {
			n, err := r.Body.Read(buf)
			if n > 0 {
				p.Feed(dec.Decode(buf[:n]))
				for _, it := range out {
					select {
					case ch <- it:
					case <-r.ctx.Done():
						ch <- StreamItem{Err: ErrAborted()}
						return
					}
				}
				out = out[:0]
			}
			if err == io.EOF {
				if s := dec.Flush(); s != "" {
					p.Feed(s)
					for _, it := range out {
						ch <- it
					}
				}
				return
			}
			if err != nil {
				ch <- StreamItem{Err: r.streamReadError(err)}
				return
			}
		}
	}()
	return ch
}
