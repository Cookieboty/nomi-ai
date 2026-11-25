// Command fakeclaude is a stand-in for the official Claude CLI, built from
// tests into each fixture directory and started by the production driver
// exactly like an installed executable. It is the hand-written fixture that
// used to be the `#!/usr/bin/python3` script in conversation_claude_test.go,
// moved to a Go program so it runs on every OS the app ships and without
// Python. Standard library only.
//
// Nothing installed, logged in or paid is involved: no real CLI, credentials,
// user data, provider, network or model. Behaviour:
//
//   - reads `mode` and appends `wire.jsonl` in the working directory the
//     driver starts it in (it never looks next to the executable);
//   - journals its launch first, exactly as the original script did:
//     log('launch', {'pid':…,'args':…,'cwd':…,'apiKeyPresent':…,'config':…}),
//     i.e. a JSON object with those keys in that order (the test decodes
//     data as a map and reads q["args"]);
//   - talks stream-json over its own stdin/stdout: one JSON frame per line,
//     every frame written and flushed as soon as the scenario produces it,
//     partial (split UTF-8) and malformed (not JSON, invalid UTF-8, 3 MiB
//     line) output written byte-for-byte;
//   - ends with a real process exit status (17 startup failure, 1 missing
//     session on resume, 19, 23, 122), and "hang" scenarios simply never end.
//
// The `wire.jsonl` journal keeps the original script's shape: one JSON object
// per line, {"kind","data"}, where data is the exact text the driver sent for
// an input frame (its JSON is echoed compact), and for a launch the object
// {"pid","args","cwd","apiKeyPresent","config"} in the original key order.
// The whole line (kind, data and newline) is one single write.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const (
	exitBadInput = 122
	exitStartup  = 17
	exitMissing  = 1
	exitAbrupt   = 19
	exitApproval = 23

	// oversizeBytes is the length of the line the "oversize" scenario writes
	// before its newline (the original printed 3 * 1024 * 1024 'x').
	oversizeBytes = 3 * 1024 * 1024
)

func main() { os.Exit(run()) }

// out writes one JSON frame followed by a newline to stdout, immediately.
func out(w io.Writer, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude: marshal:", err)
		os.Exit(exitBadInput)
	}
	_, _ = w.Write(append(b, '\n'))
}

// raw writes bytes exactly as given (partial lines, malformed frames).
func raw(w io.Writer, b []byte) {
	_, _ = w.Write(b)
}

// finish is the successful turn: the assistant reply and its result frame.
func finish(w io.Writer, sid, text string) {
	out(w, map[string]any{"type": "assistant", "session_id": sid, "message": map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}}}})
	out(w, map[string]any{"type": "result", "subtype": "success", "is_error": false, "session_id": sid, "result": text})
}

func argValue(args []string, flag string) (string, bool) {
	for i := range args {
		if args[i] == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

// journal appends {kind, data} lines to <dir>/wire.jsonl, one write per entry.
type journal struct{ path string }

func (j journal) write(kind string, data []byte) {
	f, err := os.OpenFile(j.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude: wire:", err)
		os.Exit(exitBadInput)
	}
	defer f.Close()
	line := append(append([]byte(`{"kind":`), mustJSON(kind)...), []byte(`,"data":`)...)
	line = append(append(line, data...), '}', '\n')
	if _, err := f.Write(line); err != nil {
		fmt.Fprintln(os.Stderr, "fake claude: wire:", err)
		os.Exit(exitBadInput)
	}
}

// launchData is the launch entry the original script logged as a Python dict
// literal (log('launch', {'pid':…,'args':…,'cwd':…,'apiKeyPresent':…,
// 'config':…})): the same keys in the same order, so the journal's data
// decodes as the object the tests read q["args"] from.
func launchData(pid int, args []string, cwd string, apiKeyPresent bool, config string) []byte {
	var b bytes.Buffer
	b.WriteString(`{"pid":`)
	b.WriteString(strconv.Itoa(pid))
	b.WriteString(`,"args":`)
	b.Write(mustJSON(args))
	b.WriteString(`,"cwd":`)
	b.Write(mustJSON(cwd))
	b.WriteString(`,"apiKeyPresent":`)
	b.WriteString(strconv.FormatBool(apiKeyPresent))
	b.WriteString(`,"config":`)
	b.Write(mustJSON(config))
	b.WriteByte('}')
	return b.Bytes()
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude: journal:", err)
		os.Exit(exitBadInput)
	}
	return b
}

// drain reads the driver's stdin until it closes and reports false.
func (f *frameReader) drain() bool {
	buf := make([]byte, 32<<10)
	for {
		if _, err := f.r.Read(buf); err != nil {
			return false
		}
	}
}

func run() int {
	args := os.Args[1:]
	wd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude: cwd:", err)
		return exitBadInput
	}
	wire := journal{path: filepath.Join(wd, "wire.jsonl")}
	in := os.Stdin
	stdout, stderr := os.Stdout, os.Stderr

	modeRaw, err := os.ReadFile(filepath.Join(wd, "mode"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude: mode:", err)
		return exitBadInput
	}
	mode := string(bytes.TrimRight(modeRaw, "\n\r "))
	_, apiKeyPresent := os.LookupEnv("ANTHROPIC_API_KEY")
	wire.write("launch", launchData(os.Getpid(), args, wd, apiKeyPresent, os.Getenv("CLAUDE_CONFIG_DIR")))
	if mode == "startup-error" {
		return exitStartup
	}
	_, resume := argValue(args, "--resume")
	sid, _ := argValue(args, "--session-id")
	if resume {
		sid, _ = argValue(args, "--resume")
	}
	if mode == "missing" && resume {
		fmt.Fprintln(stderr, "No conversation found with session ID: "+sid)
		return exitMissing
	}

	// A child of the driver never gets an EOF before the driver closes the
	// pipe; "hang" scenarios end only then, without success.
	n := 0
	r := newFrameReader(in)
	for {
		line, ok := r.next()
		if !ok {
			return 0
		}
		q, err := decodeInput(line)
		if err != nil {
			fmt.Fprintln(stderr, "fake claude: input:", err)
			return exitBadInput
		}
		// Journal the parsed frame (the object as sent, compact), like the
		// original script's json.dumps of the input.
		wire.write("input", mustJSON(q))
		switch typ(q) {
		case "control_request":
			var requestID any
			_ = json.Unmarshal(q["request_id"], &requestID)
			out(stdout, map[string]any{"type": "control_response", "response": map[string]any{
				"subtype": "success", "request_id": requestID, "response": map[string]any{}}})
		case "user":
			n++
			code, next := userTurn(mode, args, sid, q, n, r, stdout)
			if next {
				continue
			}
			return code
		case "control_response":
			answer, ok := object(q["response"])["response"].(map[string]any)
			decision, _ := answer["behavior"].(string)
			if !ok {
				return exitBadInput
			}
			if decision == "allow" {
				// The explicit approval must carry the original input unchanged.
				updated, err := json.Marshal(answer["updatedInput"])
				if err != nil || string(updated) != `{"file_path":"fixture.txt"}` {
					return exitApproval
				}
			}
			out(stdout, map[string]any{"type": "user", "session_id": sid, "message": map[string]any{
				"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "tool1", "content": "fixture result"}}}})
			finish(stdout, sid, "native "+decision)
		}
		if r.err != nil {
			return 0
		}
	}
}

// userTurn answers one user frame for the fixture's mode. next reports that
// the session continues (the next driver frame follows); otherwise code is
// the process exit status. Ordinary successful turns always report next=true
// (the original loop kept reading sys.stdin); only the clean-exit, nonzero and
// partial-exit fault scenarios end the process.
func userTurn(mode string, args []string, sid string, q map[string]json.RawMessage, n int, in *frameReader, stdout io.Writer) (code int, next bool) {
	switch mode {
	case "malformed":
		raw(stdout, []byte("{not-json\n"))
		return 0, true
	case "bad-utf8":
		raw(stdout, []byte("{\"type\":\"assistant\",\"text\":\"\xff\"}\n"))
		return 0, true
	case "malformed-then-echo":
		echoed := make(map[string]json.RawMessage, len(q)+1)
		for k, v := range q {
			echoed[k] = v
		}
		echoed["session_id"] = mustJSON(sid)
		initFrame := mustJSON(map[string]any{"type": "system", "subtype": "init", "session_id": sid})
		resultFrame := mustJSON(map[string]any{"type": "result", "subtype": "success", "session_id": sid, "result": "MUST_NOT_COMMIT"})
		frame := append([]byte("{not-json\n"), initFrame...)
		frame = append(append(frame, '\n'), mustJSON(echoed)...)
		frame = append(append(frame, '\n'), resultFrame...)
		raw(stdout, append(frame, '\n'))
		return 0, true
	case "oversize":
		raw(stdout, bytes.Repeat([]byte("x"), oversizeBytes))
		raw(stdout, []byte("\n"))
		return 0, true
	case "nonzero":
		return exitAbrupt, false
	case "clean-exit":
		return 0, false
	}
	permissionMode := "default"
	if v, ok := argValue(args, "--permission-mode"); ok {
		permissionMode = v
	}
	initSID, nativeMode := sid, permissionMode
	if mode == "bad-sid" {
		initSID = "wrong-native-id"
	}
	if mode == "bad-mode" {
		nativeMode = "bypassPermissions"
	}
	out(stdout, map[string]any{"type": "system", "subtype": "init", "session_id": initSID, "permissionMode": nativeMode})
	if mode != "no-echo" && mode != "no-echo-hang" {
		echoed := make(map[string]json.RawMessage, len(q)+1)
		for k, v := range q {
			echoed[k] = v
		}
		echoed["session_id"] = mustJSON(sid)
		out(stdout, echoed)
	}
	if mode == "hang" || mode == "no-echo-hang" {
		out(stdout, map[string]any{"type": "assistant", "session_id": sid, "message": map[string]any{
			"content": []any{map[string]any{"type": "text", "text": "LATE_UNCOMMITTED"}}}})
		return 0, in.drain()
	}
	if mode == "partial-exit" {
		out(stdout, map[string]any{"type": "assistant", "session_id": sid, "message": map[string]any{
			"content": []any{map[string]any{"type": "text", "text": "incomplete partial text"}}}})
		return exitAbrupt, false
	}
	if mode == "result-error" {
		out(stdout, map[string]any{"type": "result", "subtype": "error_during_execution", "is_error": true, "session_id": sid})
		return 0, true
	}
	if mode == "approval" || mode == "unsupported" {
		tool := "Read"
		if mode == "unsupported" {
			tool = "Bash"
		}
		input := map[string]any{"file_path": "fixture.txt"}
		out(stdout, map[string]any{"type": "assistant", "session_id": sid, "message": map[string]any{
			"content": []any{map[string]any{"type": "tool_use", "id": "tool1", "name": tool, "input": input}}}})
		out(stdout, map[string]any{"type": "control_request", "request_id": "permit", "request": map[string]any{
			"subtype": "can_use_tool", "tool_name": tool, "tool_use_id": "tool1", "input": input}})
		return 0, true
	}
	if mode == "split-unicode" {
		text := "分块🙂结果"
		frame := mustJSON(map[string]any{"type": "assistant", "session_id": sid, "message": map[string]any{
			"content": []any{map[string]any{"type": "text", "text": text}}}})
		frame = append(frame, '\n')
		cut := bytes.Index(frame, []byte("🙂")) + 2 // two bytes into the 4-byte rune
		raw(stdout, frame[:cut])
		time.Sleep(30 * time.Millisecond)
		raw(stdout, frame[cut:])
		out(stdout, map[string]any{"type": "result", "subtype": "success", "session_id": sid, "result": text})
		return 0, true
	}
	if mode == "result-only" {
		out(stdout, map[string]any{"type": "result", "subtype": "success", "is_error": false, "session_id": sid, "result": "native result-only"})
	} else {
		finish(stdout, sid, fmt.Sprintf("native reply %d", n))
	}
	if mode == "late-background" {
		out(stdout, map[string]any{"type": "system", "subtype": "task_started", "session_id": sid, "task_id": "unexpected", "task_type": "local_agent"})
	}
	// Like the original `for line in sys.stdin`, an ordinary successful turn
	// keeps the session alive for the next frame; the process ends only on
	// EOF (next iteration of the main loop) or on an explicit fault exit.
	return 0, true
}

// frameReader splits the driver's stdin into newline-terminated frames. It
// only buffers what has arrived: a frame is returned as soon as its newline
// is read. EOF, and a read error (the driver closed the pipe, a killed
// process gets one), both end the frame stream; a last frame without its
// newline is still returned, as the original `for line in sys.stdin` did.
func newFrameReader(r io.Reader) *frameReader {
	return &frameReader{r: r, buf: make([]byte, 0, 64<<10), chunk: make([]byte, 32<<10)}
}

type frameReader struct {
	r     io.Reader
	buf   []byte
	chunk []byte
	err   error
}

func (f *frameReader) next() ([]byte, bool) {
	for {
		if i := bytes.IndexByte(f.buf, '\n'); i >= 0 {
			line := f.buf[:i+1]
			f.buf = f.buf[i+1:]
			return line, true
		}
		if f.err != nil {
			if len(f.buf) == 0 {
				return nil, false
			}
			line := f.buf
			f.buf = nil
			return line, true
		}
		n, err := f.r.Read(f.chunk)
		f.buf = append(f.buf, f.chunk[:n]...)
		if err != nil {
			f.err = err
			if len(f.buf) == 0 {
				return nil, false
			}
		}
	}
}

// decodeInput parses one input frame like the original json.loads: the frame
// must be a JSON object, leading/trailing spaces and newlines are tolerated.
func decodeInput(line []byte) (map[string]json.RawMessage, error) {
	var q map[string]json.RawMessage
	if err := json.Unmarshal(line, &q); err != nil {
		return nil, err
	}
	if q == nil {
		return nil, fmt.Errorf("input frame is not a JSON object")
	}
	return q, nil
}

// typ is q.type for dispatching; a missing or non-string type is "".
func typ(q map[string]json.RawMessage) string {
	var s string
	_ = json.Unmarshal(q["type"], &s)
	return s
}

// object is a JSON object field decoded into a generic map (nil when absent).
func object(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return m
}
