// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// remoteTestDeadline only bounds a failing run.
const remoteTestDeadline = time.Minute

const remoteTestConn = "dev@build.example"

type remoteTestPeer struct {
	in  chan []byte
	out chan []byte
}

func (p *remoteTestPeer) GetPeerInfo() string { return "remotelink-test" }
func (p *remoteTestPeer) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-p.in
	return msg, ok
}
func (p *remoteTestPeer) SendRpcMessage(msg []byte, _ baseds.LinkId, _ string) bool {
	select {
	case p.out <- msg:
	default:
	}
	return true
}

func makeRemoteTestPeer(t *testing.T) *remoteTestPeer {
	t.Helper()
	p := &remoteTestPeer{in: make(chan []byte, 4), out: make(chan []byte, 64)}
	t.Cleanup(func() { close(p.in) })
	return p
}

func (p *remoteTestPeer) send(t *testing.T, msg RpcMessage) {
	t.Helper()
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	p.in <- raw
}

// waitAnswer waits for the answer to reqId on p.
func (p *remoteTestPeer) waitAnswer(t *testing.T, reqId string) RpcMessage {
	t.Helper()
	deadline := time.After(remoteTestDeadline)
	for {
		select {
		case raw := <-p.out:
			var msg RpcMessage
			if json.Unmarshal(raw, &msg) == nil && msg.ResId == reqId {
				return msg
			}
		case <-deadline:
			t.Fatalf("no answer to %s", reqId)
		}
	}
}

type remoteTestEnv struct {
	router     *WshRouter
	local      *remoteTestPeer
	other      *remoteTestPeer
	job        *remoteTestPeer
	wavesrv    *remoteTestPeer
	molten     *remoteTestPeer
	terminal   *remoteTestPeer
	window     *remoteTestPeer
	remote     *remoteTestPeer
	remoteLink baseds.LinkId
}

// makeRemoteTestEnv: wavesrv's own conn:local leaf, another connection's router link (conn:other), a local job, and
// an SSH host's router link that authenticated for remoteTestConn and announced its own conn route.
func makeRemoteTestEnv(t *testing.T) *remoteTestEnv {
	t.Helper()
	router := NewWshRouter()
	router.SetAsRootRouter()
	e := &remoteTestEnv{router: router, local: makeRemoteTestPeer(t), other: makeRemoteTestPeer(t), job: makeRemoteTestPeer(t), remote: makeRemoteTestPeer(t)}
	if _, err := router.RegisterTrustedLeaf(e.local, MakeConnectionRouteId("local")); err != nil {
		t.Fatal(err)
	}
	if _, err := router.RegisterTrustedLeaf(e.job, MakeJobRouteId("localjob")); err != nil {
		t.Fatal(err)
	}
	e.wavesrv = makeRemoteTestPeer(t)
	if _, err := router.RegisterTrustedLeaf(e.wavesrv, DefaultRoute); err != nil {
		t.Fatal(err)
	}
	e.molten = makeRemoteTestPeer(t)
	if _, err := router.RegisterTrustedLeaf(e.molten, "molten:browsers"); err != nil {
		t.Fatal(err)
	}
	e.terminal = makeRemoteTestPeer(t)
	if _, err := router.RegisterTerminalLeaf(e.terminal, "proc:localterm", "block-local"); err != nil {
		t.Fatal(err)
	}
	e.window = makeRemoteTestPeer(t)
	router.RegisterWindowRouter(e.window)
	e.announce(t, e.window, MakeTabRouteId("win"))
	e.announce(t, e.window, ElectronRoute)
	otherLink := router.RegisterTrustedRouter(e.other)
	router.setLinkConn(otherLink, "other")
	e.announce(t, e.other, MakeConnectionRouteId("other"))
	e.remoteLink = router.RegisterTrustedRouter(e.remote)
	router.setLinkConn(e.remoteLink, remoteTestConn)
	e.announce(t, e.remote, MakeConnectionRouteId(remoteTestConn))
	return e
}

func (e *remoteTestEnv) announce(t *testing.T, p *remoteTestPeer, route string) {
	t.Helper()
	if errStr := e.tryAnnounce(t, p, route); errStr != "" {
		t.Fatalf("announce %s: %s", route, errStr)
	}
}

var announceSeq int

// tryAnnounce announces route on p and returns the router's error, "" when the route is bound.
func (e *remoteTestEnv) tryAnnounce(t *testing.T, p *remoteTestPeer, route string) string {
	t.Helper()
	announceSeq++
	reqId := fmt.Sprintf("announce-%d-%s", announceSeq, route)
	p.send(t, RpcMessage{Command: "routeannounce", Route: ControlRoute, Source: route, ReqId: reqId})
	return p.waitAnswer(t, reqId).Error
}

// ask sends a request from the SSH host and tells whether it reached dest (true) or was refused (false).
func (e *remoteTestEnv) ask(t *testing.T, dest *remoteTestPeer, reqId string, route string, command string, data any) bool {
	t.Helper()
	e.remote.send(t, RpcMessage{Command: command, Route: route, Source: "proc:remoteshell", ReqId: reqId, Data: data})
	deadline := time.After(remoteTestDeadline)
	for {
		select {
		case raw := <-dest.out:
			var msg RpcMessage
			if json.Unmarshal(raw, &msg) == nil && msg.ReqId == reqId && msg.Command == command {
				return true
			}
			if msg.ResId == reqId && dest == e.remote {
				if !strings.Contains(msg.Error, "refused") {
					t.Fatalf("%s to %s: answered %q, not a refusal", command, route, msg.Error)
				}
				return false
			}
		case raw := <-e.remote.out:
			var msg RpcMessage
			if json.Unmarshal(raw, &msg) != nil {
				continue
			}
			if dest == e.remote && msg.ReqId == reqId && msg.Command == command {
				return true
			}
			if msg.ResId == reqId {
				if !strings.Contains(msg.Error, "refused") {
					t.Fatalf("%s to %s: answered %q, not a refusal", command, route, msg.Error)
				}
				return false
			}
		case <-deadline:
			t.Fatalf("%s to %s neither arrived nor was refused", command, route)
		}
	}
}

// #1831: an SSH host reaches no connection server but its own: this computer's conn:local (start a job, read or
// write any file, signal a process), another connection's, a local job, or another link by its link: address.
func TestRemoteHostReachesOnlyItsOwnConnection(t *testing.T) {
	e := makeRemoteTestEnv(t)
	if e.ask(t, e.local, "start-job", MakeConnectionRouteId("local"), "remotestartjob", map[string]any{"cmd": "/bin/sh"}) {
		t.Error("an SSH host started a job through this computer's connection server")
	}
	if e.ask(t, e.local, "read-file", MakeConnectionRouteId("local"), "remotefilestream", map[string]any{"path": "/etc/passwd"}) {
		t.Error("an SSH host streamed a file of this computer")
	}
	if e.ask(t, e.other, "other-conn", MakeConnectionRouteId("other"), "remotestartjob", nil) {
		t.Error("an SSH host reached another connection's server")
	}
	if e.ask(t, e.job, "local-job", MakeJobRouteId("localjob"), "jobinput", map[string]any{"jobid": "localjob"}) {
		t.Error("an SSH host typed into a local job")
	}
	localLink := e.router.GetLinkIdForRoute(MakeConnectionRouteId("local"))
	if e.ask(t, e.local, "link-addr", MakeLinkRouteId(localLink), "remotestartjob", nil) {
		t.Error("an SSH host reached conn:local by its link address")
	}
	if !e.ask(t, e.remote, "own-conn", MakeConnectionRouteId(remoteTestConn), "remotefileinfo", "/home/dev") {
		t.Error("an SSH host's request to its own connection was refused")
	}
	if !e.ask(t, e.remote, "own-link", MakeLinkRouteId(e.remoteLink), "message", nil) {
		t.Error("an SSH host's request to its own link was refused")
	}
}

// A host reaches wavesrv (whose guard checks each command), the molten routes (which check their callers) and
// Electron main for a notification; never a window's tab, Electron's other commands or a local terminal.
func TestRemoteHostRouteAllowlist(t *testing.T) {
	e := makeRemoteTestEnv(t)
	if !e.ask(t, e.wavesrv, "wavesrv", DefaultRoute, "createblock", map[string]any{"tabid": "t"}) {
		t.Error("a request to wavesrv was refused")
	}
	if !e.ask(t, e.molten, "molten", "molten:browsers", "moltenbrowseropen", map[string]any{"url": "https://example.com"}) {
		t.Error("a request to a molten route was refused")
	}
	if !e.ask(t, e.window, "notify", ElectronRoute, "notify", map[string]any{"title": "build done"}) {
		t.Error("a notification was refused")
	}
	if e.ask(t, e.window, "decrypt", ElectronRoute, "electrondecrypt", map[string]any{"ciphertext": "x"}) {
		t.Error("a host asked Electron main to decrypt")
	}
	if e.ask(t, e.window, "screenshot", MakeTabRouteId("win"), "captureblockscreenshot", map[string]any{"blockid": "b"}) {
		t.Error("a host captured a panel of the window")
	}
	if e.ask(t, e.terminal, "terminal", "proc:localterm", "message", nil) {
		t.Error("a host reached a local terminal's wsh")
	}
}

// #1831 review: a host's announcement overwrote any route, so it could take conn:local, wavesrv or a window's tab
// and receive what wavesrv sends there. It announces only free routes of its own scope.
func TestRemoteHostAnnouncesOnlyItsOwnRoutes(t *testing.T) {
	e := makeRemoteTestEnv(t)
	saved := MoltenJobConn
	t.Cleanup(func() { MoltenJobConn = saved })
	MoltenJobConn = func(jobId string) (string, bool) {
		switch jobId {
		case "remotejob":
			return remoteTestConn + ":22", true
		case "localjob", "freelocaljob":
			return "local", true
		}
		return "", false
	}
	for _, route := range []string{
		MakeConnectionRouteId("local"), MakeConnectionRouteId("other"), MakeConnectionRouteId("free@host"),
		DefaultRoute, ElectronRoute, MakeTabRouteId("win"), MakeTabRouteId("new"), MakeFeBlockRouteId("b"),
		MakeBuilderRouteId("b"), MakeControllerRouteId("b"), "proc:localterm", MakeJobRouteId("localjob"),
		MakeJobRouteId("freelocaljob"), MakeJobRouteId("unknownjob"), "molten:browsers", "bare:x",
	} {
		if errStr := e.tryAnnounce(t, e.remote, route); !strings.Contains(errStr, "refused") {
			t.Errorf("a host announced %s (%q)", route, errStr)
		}
	}
	if holder := e.router.GetLinkIdForRoute(MakeConnectionRouteId("local")); holder == e.remoteLink {
		t.Fatal("conn:local was taken over")
	}
	for _, route := range []string{"proc:remote-wsh", MakeJobRouteId("remotejob"), MakeConnectionRouteId(remoteTestConn + ":22")} {
		if errStr := e.tryAnnounce(t, e.remote, route); errStr != "" {
			t.Errorf("a connserver's own route %s was refused: %s", route, errStr)
		}
	}
	// A reconnecting connection's new link takes over its own routes while the old link is still registered.
	again := makeRemoteTestPeer(t)
	againLink := e.router.RegisterTrustedRouter(again)
	e.router.setLinkConn(againLink, remoteTestConn)
	for _, route := range []string{MakeConnectionRouteId(remoteTestConn), "proc:remote-wsh", MakeJobRouteId("remotejob")} {
		if errStr := e.tryAnnounce(t, again, route); errStr != "" {
			t.Errorf("the reconnected link could not announce %s: %s", route, errStr)
		}
	}
	if errStr := e.tryAnnounce(t, e.other, "proc:remote-wsh"); !strings.Contains(errStr, "refused") {
		t.Errorf("another connection took a host's process route (%q)", errStr)
	}
}

// Links that arrive through a connection's socket are that connection's before they authenticate, whatever their
// token says (a leaked local job token included); the token never renames the connection.
func TestConnSocketLinksAreRemote(t *testing.T) {
	router := NewWshRouter()
	router.SetAsRootRouter()
	leaf := router.registerUntrustedConnLink(makeRemoteTestPeer(t), remoteTestConn)
	router.trustLink(leaf, LinkKind_Leaf)
	if err := router.bindRoute(leaf, "proc:stolen", true); err != nil {
		t.Fatal(err)
	}
	router.setLinkBlockId(leaf, "block-local")
	router.setLinkConn(leaf, "other@host")
	if conn, ok := router.RemoteLinkConn(leaf); !ok || conn != remoteTestConn {
		t.Fatalf("a link from the connection's socket: %q %v", conn, ok)
	}
	if _, local := router.LeafSourceBlockId(leaf, "proc:stolen"); local {
		t.Fatal("a local token on a connection's socket passed for a local terminal")
	}
	own := router.registerUntrustedConnLink(makeRemoteTestPeer(t), "")
	router.trustLink(own, LinkKind_Leaf)
	if _, ok := router.RemoteLinkConn(own); ok {
		t.Fatal("a link from this computer's socket passed for a remote host")
	}
	wsl := router.registerUntrustedConnLink(makeRemoteTestPeer(t), "wsl://Ubuntu")
	router.trustLink(wsl, LinkKind_Router)
	if conn, ok := router.RemoteLinkConn(wsl); !ok || conn != "wsl://Ubuntu" {
		t.Fatalf("a WSL stdio link: %q %v", conn, ok)
	}
}

// A job manager that authenticates on a connection's socket binds only a job of that connection (#1831 re-review).
func TestRemoteJobManagerBindsOnlyItsConnectionsJobs(t *testing.T) {
	saved := MoltenJobConn
	t.Cleanup(func() { MoltenJobConn = saved })
	MoltenJobConn = func(jobId string) (string, bool) {
		switch jobId {
		case "remotejob":
			return remoteTestConn, true
		case "localjob":
			return "local", true
		}
		return "", false
	}
	router := NewWshRouter()
	router.SetAsRootRouter()
	for jobId, ok := range map[string]bool{"remotejob": true, "localjob": false, "unknownjob": false} {
		link := router.registerUntrustedConnLink(makeRemoteTestPeer(t), remoteTestConn)
		router.trustLink(link, LinkKind_Leaf)
		err := router.bindRoute(link, MakeJobRouteId(jobId), true)
		if ok != (err == nil) {
			t.Errorf("a job manager on the connection's socket binding %s: %v", jobId, err)
		}
	}
	local := router.registerUntrustedConnLink(makeRemoteTestPeer(t), "")
	router.trustLink(local, LinkKind_Leaf)
	if err := router.bindRoute(local, MakeJobRouteId("localjob"), true); err != nil {
		t.Fatalf("a local job manager: %v", err)
	}
}

func TestNormConnName(t *testing.T) {
	cases := map[string]string{"": "local", "local": "local", "local:gitbash": "local", "dev@host:22": "dev@host", "dev@host:2222": "dev@host:2222", "wsl://Ubuntu": "wsl://Ubuntu"}
	for in, want := range cases {
		if got := NormConnName(in); got != want {
			t.Errorf("NormConnName(%q) = %q, want %q", in, got, want)
		}
	}
	if sameRemoteConn("dev@host:2222", "dev@host") || !sameRemoteConn("dev@host", "dev@host:22") || sameRemoteConn("local", "") {
		t.Fatal("connection names compare wrong")
	}
}

// A copy between two connections is pulled by the destination's server: while wavesrv's copy runs, the SSH host
// reads the one file granted, and stream data and acks go through.
func TestRemoteHostReadsOnlyTheGrantedCopySource(t *testing.T) {
	e := makeRemoteTestEnv(t)
	revoke := GrantRemoteRead(remoteTestConn+":22", "local", "/Users/me/notes.txt")
	if !e.ask(t, e.local, "granted-info", MakeConnectionRouteId("local"), "remotefileinfo", "/Users/me/notes.txt") {
		t.Error("the granted copy source's info was refused")
	}
	if !e.ask(t, e.local, "granted-stream", MakeConnectionRouteId("local"), "remotefilestream", map[string]any{"path": "/Users/me/notes.txt"}) {
		t.Error("the granted copy source's stream was refused")
	}
	if e.ask(t, e.local, "other-file", MakeConnectionRouteId("local"), "remotefilestream", map[string]any{"path": "/Users/me/.ssh/id_ed25519"}) {
		t.Error("a file the copy did not grant was streamed")
	}
	if e.ask(t, e.local, "granted-write", MakeConnectionRouteId("local"), "remotewritefile", map[string]any{"path": "/Users/me/notes.txt"}) {
		t.Error("the grant let the host write the copy source")
	}
	if !e.ask(t, e.local, "ack", MakeConnectionRouteId("local"), "streamdataack", map[string]any{"id": "s1"}) {
		t.Error("a stream ack was refused")
	}
	revoke()
	if e.ask(t, e.local, "revoked", MakeConnectionRouteId("local"), "remotefilestream", map[string]any{"path": "/Users/me/notes.txt"}) {
		t.Error("the copy source was still readable after the copy")
	}
}

// A leaf whose token named a remote connection is an SSH or WSL host, never a local terminal; the windows' websocket
// and wavesrv's own leaves are not remote.
func TestRemoteLinkConn(t *testing.T) {
	e := makeRemoteTestEnv(t)
	if conn, ok := e.router.RemoteLinkConn(e.remoteLink); !ok || conn != remoteTestConn {
		t.Fatalf("SSH host's router link: %q %v", conn, ok)
	}
	leaf, err := e.router.RegisterTerminalLeaf(makeRemoteTestPeer(t), "proc:remoteleaf", "block-remote")
	if err != nil {
		t.Fatal(err)
	}
	e.router.setLinkConn(leaf, remoteTestConn)
	if conn, ok := e.router.RemoteLinkConn(leaf); !ok || conn != remoteTestConn {
		t.Fatalf("remote leaf: %q %v", conn, ok)
	}
	if _, local := e.router.LeafSourceBlockId(leaf, "proc:remoteleaf"); local {
		t.Fatal("a remote connection's leaf passed for a local terminal")
	}
	terminal, err := e.router.RegisterTerminalLeaf(makeRemoteTestPeer(t), "proc:local", "block-local")
	if err != nil {
		t.Fatal(err)
	}
	e.router.setLinkConn(terminal, "local")
	if _, ok := e.router.RemoteLinkConn(terminal); ok {
		t.Fatal("a local terminal passed for a remote host")
	}
	if _, local := e.router.LeafSourceBlockId(terminal, "proc:local"); !local {
		t.Fatal("a local terminal lost its local trust")
	}
	window := e.router.RegisterWindowRouter(makeRemoteTestPeer(t))
	if _, ok := e.router.RemoteLinkConn(window); ok {
		t.Fatal("the windows' websocket passed for a remote host")
	}
	inProcess := e.router.GetLinkIdForRoute(MakeConnectionRouteId("local"))
	if _, ok := e.router.RemoteLinkConn(inProcess); ok {
		t.Fatal("wavesrv's own conn:local leaf passed for a remote host")
	}
}

// The request guard runs before the handler of every request a WshRpc of wavesrv answers, and its refusal is the
// answer.
func TestMoltenRequestGuardRunsBeforeTheHandler(t *testing.T) {
	saved := MoltenRequestGuard
	t.Cleanup(func() { MoltenRequestGuard = saved })
	seen := make(chan string, 1)
	MoltenRequestGuard = func(_ context.Context, command string, data any) (any, error) {
		seen <- command
		return nil, errors.New("refused by the test guard")
	}
	inputCh := make(chan baseds.RpcInputChType, 1)
	outputCh := make(chan []byte, 4)
	MakeWshRpcWithChannels(inputCh, outputCh, wshrpc.RpcContext{}, nil, "guard-test")
	raw, err := json.Marshal(RpcMessage{Command: "createblock", ReqId: "guarded", Data: map[string]any{"tabid": "t"}})
	if err != nil {
		t.Fatal(err)
	}
	inputCh <- baseds.RpcInputChType{MsgBytes: raw, IngressLinkId: baseds.LinkId(7)}
	deadline := time.After(remoteTestDeadline)
	for {
		select {
		case out := <-outputCh:
			var msg RpcMessage
			if json.Unmarshal(out, &msg) != nil || msg.ResId != "guarded" {
				continue
			}
			if msg.Error != "refused by the test guard" {
				t.Fatalf("answered %q, not the guard's refusal", msg.Error)
			}
			if got := <-seen; got != "createblock" {
				t.Fatalf("the guard saw %q", got)
			}
			return
		case <-deadline:
			t.Fatal("no answer")
		}
	}
}
