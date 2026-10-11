// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeServer answers on a Unix socket as wavesrv's router does: one JSON message per line, authenticate on the
// control route first.
type fakeServer struct {
	sock    string
	token   string
	lock    sync.Mutex
	conns   int
	reqs    []rpcMessage
	answer  func(msg rpcMessage) rpcMessage
	authErr string
}

func startFakeServer(t *testing.T, token string) *fakeServer {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Unix domain socket")
	}
	// Short path: a Unix socket path must fit in about 100 bytes.
	dir, err := os.MkdirTemp("", "ah")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	s := &fakeServer{sock: filepath.Join(dir, "s.sock"), token: token}
	ln, err := net.Listen("unix", s.sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(conn)
		}
	}()
	return s
}

func (s *fakeServer) serve(conn net.Conn) {
	defer conn.Close()
	s.lock.Lock()
	s.conns++
	s.lock.Unlock()
	scanner := bufio.NewScanner(conn)
	authed := false
	for scanner.Scan() {
		var msg rpcMessage
		if json.Unmarshal(scanner.Bytes(), &msg) != nil {
			continue
		}
		s.lock.Lock()
		s.reqs = append(s.reqs, msg)
		answer, authErr := s.answer, s.authErr
		s.lock.Unlock()
		resp := rpcMessage{ResId: msg.ReqId}
		switch {
		case msg.Command == authenticateCmd:
			var tok string
			json.Unmarshal(msg.Data, &tok)
			if msg.Route != controlRoute || tok != s.token || authErr != "" {
				resp.Error = "authentication failed"
			} else {
				authed = true
				resp.Data = json.RawMessage(`{"routeid":"proc:x"}`)
			}
		case !authed:
			resp.Error = "link is unauthenticated"
		case answer != nil:
			resp = answer(msg)
			resp.ResId = msg.ReqId
		}
		// Something wavesrv could send that is not this answer: skipped by the client.
		conn.Write([]byte(`{"command":"eventrecv","data":{}}` + "\n"))
		out, _ := json.Marshal(resp)
		conn.Write(append(out, '\n'))
	}
}

func (s *fakeServer) requests() []rpcMessage {
	s.lock.Lock()
	defer s.lock.Unlock()
	return append([]rpcMessage(nil), s.reqs...)
}

func (s *fakeServer) connections() int {
	s.lock.Lock()
	defer s.lock.Unlock()
	return s.conns
}

// testToken is a token shaped like a terminal's: wavesrv checks the signature, the client never does.
func testToken(sock string, blockId string) string {
	enc := base64.RawURLEncoding
	claims, _ := json.Marshal(map[string]any{"iss": "waveterm", "sock": sock, "blockid": blockId, "routeid": "proc:x"})
	return enc.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`)) + "." + enc.EncodeToString(claims) + "." + enc.EncodeToString([]byte("sig"))
}

func envFrom(vars map[string]string, stdin string) (Env, *bytes.Buffer, *bytes.Buffer) {
	var stdout, stderr bytes.Buffer
	return Env{
		Getenv: func(k string) string { return vars[k] },
		Stdin:  strings.NewReader(stdin),
		Stdout: &stdout,
		Stderr: &stderr,
	}, &stdout, &stderr
}

func TestParseTokenClaims(t *testing.T) {
	claims, err := ParseTokenClaims(testToken("/x/wave.sock", "b-1"))
	if err != nil || claims.Sock != "/x/wave.sock" || claims.BlockId != "b-1" {
		t.Fatalf("%+v %v", claims, err)
	}
	for _, bad := range []string{"", "a.b", "a.!!!.c", "a." + base64.RawURLEncoding.EncodeToString([]byte("[1]")) + ".c"} {
		if _, err := ParseTokenClaims(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

// The forms of `molten agent state` the small program runs itself, read as cobra reads them; everything else goes to
// wsh, which reports mistakes and prints help as before.
func TestParseStateArgs(t *testing.T) {
	ok := map[string]StateArgs{
		"working --agent claude":                   {State: "working", Agent: "claude"},
		"--agent claude working":                   {State: "working", Agent: "claude"},
		"--agent=codex done {\"type\":\"x\"}":      {State: "done", Agent: "codex"},
		"waiting --agent claude --stdin":           {State: "waiting", Agent: "claude", Stdin: true},
		"waiting --stdin=false --message hi":       {State: "waiting", Message: "hi"},
		"error --message=a=b":                      {State: "error", Message: "a=b"},
		"idle":                                     {State: "idle"},
		"done --agent my-agent-2 --stdin=true":     {State: "done", Agent: "my-agent-2", Stdin: true},
		"working --agent claude --message --stdin": {State: "working", Agent: "claude", Message: "--stdin"},
	}
	for line, want := range ok {
		got, valid := ParseStateArgs(strings.Fields(line))
		if !valid || got != want {
			t.Errorf("%s: %+v %v, want %+v", line, got, valid, want)
		}
	}
	for _, line := range []string{
		"", "--help", "working -h", "working --agent", "bogus --agent claude", "working --agent Claude",
		"working --agent -x", "working a b", "working --stdin=yes", "working -b block", "working --block=x", "working --",
	} {
		if got, valid := ParseStateArgs(strings.Fields(line)); valid {
			t.Errorf("%q is wsh's: %+v", line, got)
		}
	}
}

func TestValidAgentId(t *testing.T) {
	for _, id := range []string{"claude", "a", "open-code", "x9", "9x", strings.Repeat("a", 32)} {
		if !ValidAgentId(id) {
			t.Errorf("%q refused", id)
		}
	}
	for _, id := range []string{"", "-a", "A", "a_b", "a b", "é", strings.Repeat("a", 33)} {
		if ValidAgentId(id) {
			t.Errorf("%q accepted", id)
		}
	}
}

func TestRunFastState(t *testing.T) {
	s := startFakeServer(t, "")
	token := testToken(s.sock, "block-1")
	s.token = token
	env, stdout, stderr := envFrom(map[string]string{jwtVarName: token, "WAVETERM_BLOCKID": "other"}, `{"message":"Claude needs your permission"}`)
	handled, code := RunFast([]string{"agent", "state", "waiting", "--agent", "claude", "--stdin"}, env)
	if !handled || code != 0 || stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("handled %v code %d out %q err %q", handled, code, stdout, stderr)
	}
	reqs := s.requests()
	if len(reqs) != 2 || reqs[0].Command != authenticateCmd || reqs[1].Command != AgentStateSetCommand || reqs[1].Route != AgentStatesRoute {
		t.Fatalf("requests: %+v", reqs)
	}
	if reqs[0].ReqId == reqs[1].ReqId || len(reqs[1].ReqId) != 36 || reqs[1].Timeout <= 0 {
		t.Errorf("request ids and timeout: %+v", reqs)
	}
	var sent AgentStateRequest
	json.Unmarshal(reqs[1].Data, &sent)
	want := AgentStateRequest{BlockId: "block-1", State: "waiting", Agent: "claude", Message: "Claude needs your permission"}
	if sent != want {
		t.Errorf("sent %+v, want %+v (the token's block first)", sent, want)
	}

	// wavesrv's error is the command's, as wsh prints it.
	s.answer = func(msg rpcMessage) rpcMessage {
		return rpcMessage{Error: "no agent is known in this terminal: name it with --agent"}
	}
	env, _, stderr = envFrom(map[string]string{jwtVarName: token}, "")
	handled, code = RunFast([]string{"agent", "state", "working"}, env)
	if !handled || code != 1 || stderr.String() != "molten: no agent is known in this terminal: name it with --agent\n" {
		t.Errorf("error: handled %v code %d err %q", handled, code, stderr)
	}

	s.authErr = "x"
	env, _, stderr = envFrom(map[string]string{jwtVarName: token}, "")
	if handled, code = RunFast([]string{"agent", "state", "working", "--agent", "claude"}, env); !handled || code != 1 ||
		!strings.Contains(stderr.String(), "error authenticating") {
		t.Errorf("auth failure: handled %v code %d err %q", handled, code, stderr)
	}
}

func TestRunFastHandsTheRestToWsh(t *testing.T) {
	env, _, _ := envFrom(map[string]string{jwtVarName: testToken("/nonexistent/s.sock", "b")}, "")
	for _, args := range [][]string{
		nil, {"agent"}, {"agent", "list"}, {"mod", "list"}, {"agent", "state"}, {"agent", "state", "bogus"},
		{"agent", "state", "--help"}, {"agent", "statusline", "--help"}, {"agent", "statusline", "-h"},
	} {
		if handled, _ := RunFast(args, env); handled {
			t.Errorf("%v: run by the small program", args)
		}
	}
	// No token: wsh says it must run in a terminal.
	env, _, _ = envFrom(map[string]string{}, "")
	if handled, _ := RunFast([]string{"agent", "state", "working", "--agent", "claude"}, env); handled {
		t.Error("no token: wsh's")
	}
}

const relayInput = `{"session_id":"s","rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},"seven_day":{"used_percentage":41,"resets_at":1738857600}}}`

// The relay hands the same windows over once, and again only when they change or the resend time is past.
func TestRunFastStatusLineSendsUnchangedWindowsOnce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	s := startFakeServer(t, "")
	token := testToken(s.sock, "block-2")
	s.token = token
	s.answer = func(msg rpcMessage) rpcMessage { return rpcMessage{Data: json.RawMessage(`{"kept":true}`)} }
	cache := t.TempDir()
	run := func(input string) (int, string) {
		env, stdout, _ := envFrom(map[string]string{jwtVarName: token, "WAVETERM_BLOCKID": "block-2"}, input)
		env.CacheDir = cache
		handled, code := RunFast([]string{"agent", "statusline", "--", "cat >/dev/null; printf ok"}, env)
		if !handled {
			t.Fatal("the relay is the small program's")
		}
		return code, stdout.String()
	}
	for i := 0; i < 3; i++ {
		if code, out := run(relayInput); code != 0 || out != "ok" {
			t.Fatalf("run %d: %d %q", i, code, out)
		}
	}
	if n := s.connections(); n != 1 {
		t.Fatalf("unchanged windows: %d connections, want 1", n)
	}
	reqs := s.requests()
	var sent AgentStatusLineRequest
	json.Unmarshal(reqs[len(reqs)-1].Data, &sent)
	if reqs[len(reqs)-1].Command != AgentStatusLineCommand || reqs[len(reqs)-1].Route != CompanionRoute || sent.BlockId != "block-2" ||
		sent.FiveHour == nil || sent.FiveHour.UsedPercent != 23.5 {
		t.Fatalf("sent %+v %+v", reqs[len(reqs)-1], sent)
	}
	run(strings.Replace(relayInput, "23.5", "24", 1))
	if n := s.connections(); n != 2 {
		t.Errorf("changed windows are sent: %d connections", n)
	}
	// Outside MoltenTerm: only the command runs.
	env, stdout, _ := envFrom(map[string]string{}, relayInput)
	env.CacheDir = cache
	if handled, code := RunFast([]string{"agent", "statusline", "printf x"}, env); !handled || code != 0 || stdout.String() != "x" {
		t.Errorf("outside MoltenTerm: %v %d %q", handled, code, stdout)
	}
	if n := s.connections(); n != 2 {
		t.Errorf("outside MoltenTerm nothing is sent: %d connections", n)
	}
}

func TestStatusLineSendDue(t *testing.T) {
	dir := t.TempDir()
	now := time.UnixMilli(1_800_000_000_000)
	req := AgentStatusLineRequest{BlockId: "b1", RateLimits: true, FiveHour: &StatusLineWindow{UsedPercent: 10, ResetsAt: 5}}
	if !StatusLineSendDue(dir, req, now) {
		t.Fatal("first run: due")
	}
	RecordStatusLineSent(dir, req, true, now)
	same := req
	same.FiveHour = &StatusLineWindow{UsedPercent: 10, ResetsAt: 5}
	if StatusLineSendDue(dir, same, now.Add(StatusLineResendAfter-time.Second)) {
		t.Error("same windows, recent: not due")
	}
	if !StatusLineSendDue(dir, same, now.Add(StatusLineResendAfter)) {
		t.Error("same windows, resend time past: due (the companion's Updated age)")
	}
	if !StatusLineSendDue(dir, same, now.Add(-time.Second)) {
		t.Error("clock went back: due")
	}
	changed := req
	changed.FiveHour = &StatusLineWindow{UsedPercent: 11, ResetsAt: 5}
	if !StatusLineSendDue(dir, changed, now.Add(time.Second)) {
		t.Error("changed windows: due")
	}
	if !StatusLineSendDue(dir, AgentStatusLineRequest{BlockId: "b2"}, now) {
		t.Error("another pane: due")
	}
	RecordStatusLineSent(dir, req, false, now)
	if StatusLineSendDue(dir, req, now.Add(StatusLineResendAfterNotKept-time.Second)) ||
		!StatusLineSendDue(dir, req, now.Add(StatusLineResendAfterNotKept)) {
		t.Error("not kept (plan usage hidden): due again sooner")
	}
	os.WriteFile(filepath.Join(dir, "b1.json"), []byte("{broken"), 0600)
	if !StatusLineSendDue(dir, req, now) {
		t.Error("unreadable record: due")
	}
	for _, id := range []string{"", "../x", "a/b", "a.b"} {
		if !StatusLineSendDue(dir, AgentStatusLineRequest{BlockId: id}, now) {
			t.Errorf("block %q: never cached", id)
		}
		RecordStatusLineSent(dir, AgentStatusLineRequest{BlockId: id}, true, now)
	}
	if !StatusLineSendDue("", req, now) {
		t.Error("no cache folder: always due")
	}
}

func TestStatusLineCachePrunesOldRecords(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	old := filepath.Join(dir, "gone.json")
	os.WriteFile(old, []byte("{}"), 0600)
	os.Chtimes(old, now.Add(-48*time.Hour), now.Add(-48*time.Hour))
	recent := filepath.Join(dir, "recent.json")
	os.WriteFile(recent, []byte("{}"), 0600)
	RecordStatusLineSent(dir, AgentStatusLineRequest{BlockId: "new"}, true, now)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("a day-old record is removed when a new pane writes its first")
	}
	for _, f := range []string{recent, filepath.Join(dir, "new.json")} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("%s kept: %v", f, err)
		}
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 2 {
		t.Errorf("no temporary file left: %d entries", len(entries))
	}
}

func TestStatusLineKept(t *testing.T) {
	cases := map[string]bool{`{"kept":true}`: true, `{"kept":false}`: false, `null`: true, ``: true, `{}`: true}
	for data, want := range cases {
		if got := StatusLineKept(json.RawMessage(data)); got != want {
			t.Errorf("%q: %v", data, got)
		}
	}
}
