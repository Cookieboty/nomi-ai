// Package stream mirrors packages/gateway/src/stream: SSE decoders (upstream
// wire → NormEvent), encoders (NormEvent → downstream wire), the non-streaming
// JSON paths and the converter that ties them together.
package stream

// GeminiStatus is geminiErrorStatus's result.
type GeminiStatus struct {
	Code   float64
	Status string
}

// GeminiErrorStatus is geminiErrorStatus.
func GeminiErrorStatus(errorType *string) GeminiStatus {
	t := ""
	if errorType != nil {
		t = *errorType
	}
	switch t {
	case "rate_limit_error", "rate_limit_exceeded":
		return GeminiStatus{429, "RESOURCE_EXHAUSTED"}
	case "overloaded_error":
		return GeminiStatus{503, "UNAVAILABLE"}
	case "authentication_error":
		return GeminiStatus{401, "UNAUTHENTICATED"}
	case "permission_error":
		return GeminiStatus{403, "PERMISSION_DENIED"}
	case "invalid_request_error":
		return GeminiStatus{400, "INVALID_ARGUMENT"}
	}
	return GeminiStatus{500, "INTERNAL"}
}
