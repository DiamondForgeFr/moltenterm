// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"context"
	"encoding/json"
	"errors"
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
	p.send(t, RpcMessage{Command: "routeannounce", Route: ControlRoute, Source: route, ReqId: "announce-" + route})
	if answer := p.waitAnswer(t, "announce-"+route); answer.Error != "" {
		t.Fatalf("announce %s: %s", route, answer.Error)
	}
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

