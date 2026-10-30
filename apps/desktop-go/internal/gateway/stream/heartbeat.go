package stream

// Heartbeat kinds (heartbeat.ts).
const (
	HeartbeatComment = ": keepalive\n\n"
	HeartbeatPing    = "event: ping\ndata: {\"type\":\"ping\"}\n\n"
)

// DefaultHeartbeatKind is defaultHeartbeatKind.
func DefaultHeartbeatKind(wire string) string {
	if wire == "messages" {
		return "ping"
	}
	return "comment"
}

// Heartbeat is heartbeat(); kind "" means the wire default.
func Heartbeat(wire, kind string) string {
	if kind == "" {
		kind = DefaultHeartbeatKind(wire)
	}
	if kind == "ping" && wire == "messages" {
		return HeartbeatPing
	}
	return HeartbeatComment
}
