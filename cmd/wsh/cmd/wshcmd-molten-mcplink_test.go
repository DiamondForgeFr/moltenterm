// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wavejwt"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// fakeWavesrv answers the MCP server's requests on a unix socket, and can be stopped and started again on the same
// path, like MoltenTerm restarting under a running agent (#1029).
type fakeWavesrv struct {
	t    *testing.T
	path string

	lock     sync.Mutex
	listener net.Listener
	conns    []net.Conn
	connNo   int
	refuse   bool
	// silentConn: the connection number whose requests get no answer, the probe's included.
	silentConn int
	// dieOn: a tool whose call closes the connection instead of answering, once.
	dieOn  string
	hellos int
	calls  map[string]int
	notice chan handoffwire.LinkNoticeRequest
}

func makeFakeWavesrv(t *testing.T) *fakeWavesrv {
	// A unix socket path is limited to about 100 bytes: t.TempDir() is too long on some systems.
	dir, err := os.MkdirTemp("/tmp", "mt-mcplink-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &fakeWavesrv{t: t, path: filepath.Join(dir, "wave.sock"), calls: map[string]int{},
		notice: make(chan handoffwire.LinkNoticeRequest, 10)}
	t.Cleanup(f.stop)
	return f
}

func (f *fakeWavesrv) token() string {
	claims := &wavejwt.WaveJwtClaims{Sock: f.path, BlockId: "block1"}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("test"))
	if err != nil {
		f.t.Fatal(err)
	}
	return token
}

func (f *fakeWavesrv) start() {
	listener, err := net.Listen("unix", f.path)
	if err != nil {
		f.t.Fatal(err)
	}
	f.lock.Lock()
	f.listener = listener
	f.lock.Unlock()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go f.serve(conn, f.addConn(conn))
		}
	}()
}

func (f *fakeWavesrv) addConn(conn net.Conn) int {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.conns = append(f.conns, conn)
	f.connNo++
	return f.connNo
}

// stop closes the listener and every connection, and removes the socket, as a quitting wavesrv does.
func (f *fakeWavesrv) stop() {
	f.lock.Lock()
	defer f.lock.Unlock()
	if f.listener != nil {
		f.listener.Close()
		f.listener = nil
	}
	for _, c := range f.conns {
		c.Close()
	}
	f.conns = nil
	os.Remove(f.path)
}

func (f *fakeWavesrv) set(fn func(f *fakeWavesrv)) {
	f.lock.Lock()
	defer f.lock.Unlock()
	fn(f)
}

func (f *fakeWavesrv) counts() (int, map[string]int) {
	f.lock.Lock()
	defer f.lock.Unlock()
	calls := map[string]int{}
	for k, v := range f.calls {
		calls[k] = v
	}
	return f.hellos, calls
}

func (f *fakeWavesrv) serve(conn net.Conn, connNo int) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var writeLock sync.Mutex
	reply := func(resId string, data any, errText string) {
		barr, _ := json.Marshal(wshutil.RpcMessage{ResId: resId, Data: data, Error: errText})
		writeLock.Lock()
		defer writeLock.Unlock()
		conn.Write(append(barr, '\n'))
	}
	for scanner.Scan() {
		var msg wshutil.RpcMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil || msg.ReqId == "" && msg.Command == "" {
			continue
		}
		data, errText, answer := f.handle(conn, connNo, msg)
		if answer && msg.ReqId != "" {
			reply(msg.ReqId, data, errText)
		}
	}
}

func (f *fakeWavesrv) handle(conn net.Conn, connNo int, msg wshutil.RpcMessage) (any, string, bool) {
	f.lock.Lock()
	defer f.lock.Unlock()
	switch msg.Command {
	case wshrpc.Command_Authenticate:
		if f.refuse {
			return nil, "error validating token: invalid token", true
		}
		return wshrpc.CommandAuthenticateRtnData{RouteId: fmt.Sprintf("proc:%d", connNo)}, "", true
	case "setpeerinfo":
		return nil, "", true
	}
	if connNo == f.silentConn {
		return nil, "", false
	}
	sessionId := fmt.Sprintf("s%d", connNo)
	switch msg.Command {
	case "controlgetrouteid":
		return fmt.Sprintf("proc:%d", connNo), "", true
	case mcpbrowser.HelloCommand:
		f.hellos++
		return mcpbrowser.HelloResult{SessionId: sessionId}, "", true
	case mcpbrowser.CallCommand:
		var req mcpbrowser.CallRequest
		barr, _ := json.Marshal(msg.Data)
		json.Unmarshal(barr, &req)
		f.calls[req.Tool]++
		if req.Tool == f.dieOn {
			f.dieOn = ""
			conn.Close()
			return nil, "", false
		}
		if req.SessionId != sessionId {
			return mcpbrowser.ErrorResult(mcpbrowser.ErrSessionEnded), "", true
		}
		return mcpbrowser.TextResult("ok " + req.Tool), "", true
	case handoffwire.ListCommand:
		return handoffwire.ListResult{You: &handoffwire.AgentEntry{FirstName: "Valentin", You: true}, Agents: []handoffwire.AgentEntry{}}, "", true
	case handoffwire.LinkNoticeCommand:
		var req handoffwire.LinkNoticeRequest
		barr, _ := json.Marshal(msg.Data)
		json.Unmarshal(barr, &req)
		f.notice <- req
		return nil, "", true
	case mcpbrowser.ByeCommand:
		return nil, "", true
	}
	return nil, "unknown command " + msg.Command, true
}

func makeTestMcpBackend(t *testing.T, f *fakeWavesrv) *moltenMcpRpcBackend {
	b := makeMoltenMcpRpcBackend(f.token(), moltenMcpBrowserProtocol, moltenMcpDial)
	b.link.redialFirst = time.Millisecond
	b.link.redialMax = 20 * time.Millisecond
	t.Cleanup(b.Close)
	return b
}

func resultText(r mcpbrowser.CallResult) string {
	if len(r.Content) == 0 {
		return ""
	}
	return r.Content[0].Text
}

// waitLinkGone waits until the server has seen its connection end.
func waitLinkGone(t *testing.T, b *moltenMcpRpcBackend) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for b.link.current() != nil {
		if time.Now().After(deadline) {
			t.Fatal("the link never saw its connection end")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestMoltenMcpLinkReconnectsAfterMoltenTermRestarts(t *testing.T) {
	f := makeFakeWavesrv(t)
	f.start()
	b := makeTestMcpBackend(t, f)
	b.Start(context.Background(), mcpbrowser.ClientInfo{Name: "claude-code"})
	ctx := context.Background()
	if r := b.CallTool(ctx, mcpbrowser.ToolTabsContext, nil); r.IsError || resultText(r) != "ok tabs_context" {
		t.Fatalf("before the restart: %+v", r)
	}

	f.stop()
	waitLinkGone(t, b)
	f.start()

	if r := b.CallTool(ctx, mcpbrowser.ToolTabsContext, nil); r.IsError || resultText(r) != "ok tabs_context" {
		t.Fatalf("after the restart: %+v", r)
	}
	if r := b.CallTool(ctx, mcpbrowser.ToolListAgents, nil); r.IsError || !strings.Contains(resultText(r), "Valentin") {
		t.Fatalf("list_agents after the restart: %+v", r)
	}
	if hellos, _ := f.counts(); hellos != 2 {
		t.Fatalf("a new session on the new link: %d hellos", hellos)
	}
}

func TestMoltenMcpLinkFailsFastThenTellsTheDeveloperOnceItIsBack(t *testing.T) {
	f := makeFakeWavesrv(t)
	f.start()
	b := makeTestMcpBackend(t, f)
	b.Start(context.Background(), mcpbrowser.ClientInfo{Name: "codex"})
	f.stop()
	waitLinkGone(t, b)

	// Each call would wait for its 200-second limit if a dead link were not seen: a hang here is the regression.
	ctx := context.Background()
	for _, tool := range []string{mcpbrowser.ToolTabsContext, mcpbrowser.ToolListAgents} {
		r := b.CallTool(ctx, tool, nil)
		if !r.IsError || !strings.HasPrefix(resultText(r), moltenMcpNotReachable) || !strings.Contains(resultText(r), "Open MoltenTerm") {
			t.Fatalf("%s while MoltenTerm is down: %+v", tool, r)
		}
	}
	select {
	case n := <-f.notice:
		t.Fatalf("a notice while down: %+v", n)
	default:
	}

	f.start()
	var notice handoffwire.LinkNoticeRequest
	select {
	case notice = <-f.notice:
	case <-time.After(time.Minute):
		t.Fatal("no notice after MoltenTerm came back")
	}
	if notice.Failed != 2 || notice.Server != moltenMcpBrowserServer || notice.Token != f.token() || notice.FirstName != "Valentin" {
		t.Fatalf("notice: %+v", notice)
	}
	if r := b.CallTool(ctx, mcpbrowser.ToolTabsContext, nil); r.IsError {
		t.Fatalf("after the reconnect: %+v", r)
	}
	select {
	case n := <-f.notice:
		t.Fatalf("a second notice: %+v", n)
	default:
	}
}

func TestMoltenMcpLinkRefusedTokenAsksForANewTerminal(t *testing.T) {
	f := makeFakeWavesrv(t)
	f.set(func(f *fakeWavesrv) { f.refuse = true })
	f.start()
	b := makeTestMcpBackend(t, f)
	b.Start(context.Background(), mcpbrowser.ClientInfo{Name: "claude-code"})
	r := b.CallTool(context.Background(), mcpbrowser.ToolTabsContext, nil)
	if !r.IsError || !strings.Contains(resultText(r), "refused this terminal's credentials") || !strings.Contains(resultText(r), "start it again in a MoltenTerm terminal") {
		t.Fatalf("refused token: %+v", r)
	}
}

func TestMoltenMcpLinkReplaysReadsButNeverActions(t *testing.T) {
	f := makeFakeWavesrv(t)
	f.start()
	b := makeTestMcpBackend(t, f)
	b.Start(context.Background(), mcpbrowser.ClientInfo{Name: "claude-code"})
	ctx := context.Background()

	f.set(func(f *fakeWavesrv) { f.dieOn = mcpbrowser.ToolReadPage })
	if r := b.CallTool(ctx, mcpbrowser.ToolReadPage, nil); r.IsError || resultText(r) != "ok read_page" {
		t.Fatalf("read_page whose link died: %+v", r)
	}

	f.set(func(f *fakeWavesrv) { f.dieOn = mcpbrowser.ToolNavigate })
	r := b.CallTool(ctx, mcpbrowser.ToolNavigate, nil)
	if !r.IsError || resultText(r) != (moltenMcpLostError{}).Error() {
		t.Fatalf("navigate whose link died: %+v", r)
	}
	_, calls := f.counts()
	// read_page: the call the link died under, its replay on the new link (refused: the session was the old link's),
	// then the call in the new session. navigate: once.
	if calls[mcpbrowser.ToolReadPage] != 3 || calls[mcpbrowser.ToolNavigate] != 1 {
		t.Fatalf("calls: %v", calls)
	}
	if r := b.CallTool(ctx, mcpbrowser.ToolNavigate, nil); r.IsError {
		t.Fatalf("the next action: %+v", r)
	}
}

func TestMoltenMcpLinkDropsASilentLink(t *testing.T) {
	f := makeFakeWavesrv(t)
	f.set(func(f *fakeWavesrv) { f.silentConn = 1 })
	f.start()
	link := makeMoltenMcpLink(f.token(), moltenMcpDial)
	t.Cleanup(link.close)
	if _, _, err := link.get(); err != nil {
		t.Fatal(err)
	}
	// The short limit only makes the silent connection time out; the probe that follows finds it dead.
	resp, gen, err := link.call(context.Background(), handoffwire.ListCommand, handoffwire.ListRequest{}, handoffwire.RouteId, 200, true)
	if err != nil || gen != 2 {
		t.Fatalf("silent link: resp=%v gen=%d err=%v", resp, gen, err)
	}
}
