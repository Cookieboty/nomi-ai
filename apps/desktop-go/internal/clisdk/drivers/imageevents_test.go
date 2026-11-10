package drivers

import "testing"

// All ACP plugins (including Kimi and MiniMax) pass through this mapper.
func TestAcpUserImagesAccumulateAndKeepOneTurnIdentity(t *testing.T) {
	mapper := NewAcpMapper()
	events := mapper.Update(O("sessionUpdate", "user_message_chunk", "content", O("type", "image", "mimeType", "image/png", "data", "YQ==")))
	if len(events) != 1 || events[0].Get("type") != "user-message" {
		t.Fatalf("image-only event lost: %v", events)
	}
	first := events[0].Get("sourceId")
	events = mapper.Update(O("sessionUpdate", "user_message_chunk", "content", O("type", "text", "text", "describe")))
	if len(events) != 1 || events[0].Get("sourceId") != first || events[0].Get("text") != "describe" {
		t.Fatalf("turn lost text or identity: %v", events)
	}
	mapper.Update(O("sessionUpdate", "agent_message_chunk", "content", O("type", "text", "text", "answer")))
	events = mapper.Update(O("sessionUpdate", "user_message_chunk", "content", O("type", "image", "mimeType", "image/png", "data", "YQ==")))
	if len(events) != 1 || events[0].Get("sourceId") == first || events[0].Get("text") != "" {
		t.Fatalf("new turn reused previous user: %v", events)
	}
}
