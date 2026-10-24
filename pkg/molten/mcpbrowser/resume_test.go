// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mcpbrowser

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeReexec records the handovers the server asks for and never replaces anything (#1049).
type fakeReexec struct {
	lock    sync.Mutex
	changed bool
	states  []ResumeState
	pending []string
}

func (r *fakeReexec) Changed() bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	return r.changed
}

func (r *fakeReexec) Exec(state ResumeState, pending []byte) error {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.changed = false
	r.states = append(r.states, state)
	r.pending = append(r.pending, string(pending))
	return errors.New("stays")
}

func (r *fakeReexec) set(changed bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.changed = changed
}

func (r *fakeReexec) handovers() ([]ResumeState, []string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	return append([]ResumeState{}, r.states...), append([]string{}, r.pending...)
}

func startReexecServer(t *testing.T, backend Backend, r *fakeReexec, resume *ResumeState) *testClient {
	t.Helper()
	c := startServerWith(t, backend, func(s *Server) {
		s.SetReexec(r)
		if resume != nil {
			s.Resume(*resume)
		}
	})
	t.Cleanup(c.close)
	return c
}

const (
	testInitLine = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"any-mcp-client","version":"1.2.3"}}}`
	testCallLine = `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tabs_context","arguments":{}}}`
	testPingLine = `{"jsonrpc":"2.0","id":3,"method":"ping"}`
)

func TestReexecHandsOverTheSessionAndTheUnreadInput(t *testing.T) {
	r := &fakeReexec{}
	c := startReexecServer(t, &fakeBackend{}, r, nil)
	c.send(testInitLine)
	c.recv()
	r.set(true)
	// One write: the second line sits in the server's buffer when the first is read.
	c.send(testCallLine + "\n" + testPingLine)
	c.recv()
	c.recv()
	states, pending := r.handovers()
	if len(states) != 1 {
		t.Fatalf("handovers: %d", len(states))
	}
	want := ResumeState{Initialized: true, ProtocolVersion: "2025-06-18", ClientName: "any-mcp-client", ClientVersion: "1.2.3",
		ToolsHash: BrowserSpec().toolsHash()}
	if states[0] != want {
		t.Fatalf("state = %+v, want %+v", states[0], want)
	}
	if pending[0] != testCallLine+"\n"+testPingLine+"\n" {
		t.Fatalf("pending = %q", pending[0])
	}
}

func TestReexecWaitsUntilNoCallIsRunning(t *testing.T) {
	backend := &fakeBackend{block: make(chan struct{})}
	r := &fakeReexec{}
	c := startReexecServer(t, backend, r, nil)
	c.send(testCallLine)
	waitCalls(t, backend, 1)
	r.set(true)
	c.send(testPingLine)
	if resp := c.recv(); resp["id"] != float64(3) {
		t.Fatalf("ping = %v", resp)
	}
	if states, _ := r.handovers(); len(states) != 0 {
		t.Fatalf("a handover with a call running: %+v", states)
	}
	close(backend.block)
	if resp := c.recv(); resp["id"] != float64(2) {
		t.Fatalf("call = %v", resp)
	}
	// The first message after the answer, however fast the client sends it, finds the server idle.
	c.send(testPingLine)
	c.recv()
	if states, _ := r.handovers(); len(states) != 1 || states[0].Initialized {
		t.Fatalf("the handover once idle: %+v", states)
	}
}

func TestResumedServerAnswersWithoutInitialize(t *testing.T) {
	backend := &fakeBackend{}
	resume := ResumeState{Initialized: true, ProtocolVersion: "2025-06-18", ClientName: "other-mcp-client", ClientVersion: "0.9",
		ToolsHash: BrowserSpec().toolsHash(), Resumes: 2}
	c := startReexecServer(t, backend, &fakeReexec{}, &resume)
	c.send(testCallLine)
	resp := c.recv()
	if resp["id"] != float64(2) || resp["result"] == nil {
		t.Fatalf("first message after the resume = %v", resp)
	}
	if c.server.Resumes() != 3 {
		t.Fatalf("resumes = %d", c.server.Resumes())
	}
	backend.lock.Lock()
	defer backend.lock.Unlock()
	if len(backend.started) != 1 || backend.started[0] != (ClientInfo{Name: "other-mcp-client", Version: "0.9"}) {
		t.Fatalf("the backend starts with the carried client: %v", backend.started)
	}
}

func TestResumedServerAnnouncesAChangedToolList(t *testing.T) {
	resume := ResumeState{Initialized: true, ClientName: "any-mcp-client", ToolsHash: "other"}
	c := startReexecServer(t, &fakeBackend{}, &fakeReexec{}, &resume)
	if msg := c.recv(); msg["method"] != "notifications/tools/list_changed" || msg["id"] != nil {
		t.Fatalf("first message = %v", msg)
	}
	c.send(testPingLine)
	if resp := c.recv(); resp["id"] != float64(3) {
		t.Fatalf("ping = %v", resp)
	}
}

func waitCalls(t *testing.T, backend *fakeBackend, n int) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for {
		backend.lock.Lock()
		got := len(backend.calls)
		backend.lock.Unlock()
		if got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("calls: %d, want %d", got, n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
