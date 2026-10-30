// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"fmt"
	"testing"
	"time"
)

type delayedGateEnv struct {
	*fakeEnv
	blocked bool
	entered chan struct{}
	resume  chan struct{}
}

func TestMoveToFullSessionKeepsOriginalHolder(t *testing.T) {
	m, env, _ := makeWorld(t)
	a := hello(t, m, "proc:a", "tok-a", "a")
	b := hello(t, m, "proc:b", "tok-b", "b")
	share(t, m, a, false)
	m.lock.Lock()
	id := m.sessions[a].tabFor(userTab).id
	m.lock.Unlock()
	m.engageTab(a, id)
	for i := 0; i < maxTabsPerSession; i++ {
		if m.addTab(b, TabKey{PanelId: "p1", BrowserTabId: fmt.Sprintf("other-%d", i)}, OriginShared, "") == 0 {
			t.Fatal("could not fill the replacement session")
		}
	}
	_, err := m.Share(context.Background(), "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: b, Move: true})
	if err == nil || holderOf(m) != a || !env.controlled(userTab) {
		t.Fatalf("failed move must leave the original holder in control: %v, holder %q", err, holderOf(m))
	}
}

func (e *delayedGateEnv) SetControl(key TabKey, controlled bool) {
	if controlled == e.blocked {
		close(e.entered)
		<-e.resume
	}
	e.fakeEnv.SetControl(key, controlled)
}

func waitForControlState(t *testing.T, m *Manager, sessionId string, controlled bool) {
	t.Helper()
	deadline := time.After(time.Minute)
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		m.lock.Lock()
		s := m.sessions[sessionId]
		var matches bool
		if s != nil {
			if tab := s.tabFor(userTab); tab != nil {
				matches = tab.controlled == controlled
			}
		}
		m.lock.Unlock()
		if matches {
			return
		}
		select {
		case <-ticker.C:
		case <-deadline:
			t.Fatal("control state did not change")
		}
	}
}

func TestStopDoesNotDisableReplacementControl(t *testing.T) {
	m, env, _ := makeWorld(t)
	a := hello(t, m, "proc:a", "tok-a", "a")
	b := hello(t, m, "proc:b", "tok-b", "b")
	share(t, m, a, false)
	gate := &delayedGateEnv{fakeEnv: env, entered: make(chan struct{}), resume: make(chan struct{})}
	m.env = gate
	done := make(chan error, 1)
	go func() {
		done <- m.Control("tab:t1", ControlRequest{BlockId: "p1", BrowserTabId: "user-tab", Action: ControlStop, ExpectedSessionId: a})
	}()
	<-gate.entered
	if _, err := m.Share(context.Background(), "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: b}); err != nil {
		t.Fatal(err)
	}
	m.lock.Lock()
	id := m.sessions[b].tabFor(userTab).id
	m.lock.Unlock()
	engaged := make(chan struct{})
	go func() { m.engageTab(b, id); close(engaged) }()
	waitForControlState(t, m, b, true)
	close(gate.resume)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	<-engaged
	if !env.controlled(userTab) {
		t.Fatal("stale stop disabled replacement agent's control")
	}
}

func TestDelayedEngagementDoesNotOverrideTakeover(t *testing.T) {
	m, env, _ := makeWorld(t)
	a := hello(t, m, "proc:a", "tok-a", "a")
	share(t, m, a, false)
	m.lock.Lock()
	id := m.sessions[a].tabFor(userTab).id
	m.lock.Unlock()
	gate := &delayedGateEnv{fakeEnv: env, blocked: true, entered: make(chan struct{}), resume: make(chan struct{})}
	m.env = gate
	engaged := make(chan struct{})
	go func() { m.engageTab(a, id); close(engaged) }()
	<-gate.entered
	done := make(chan error, 1)
	go func() {
		done <- m.Control("tab:t1", ControlRequest{BlockId: "p1", BrowserTabId: "user-tab", Action: ControlTakeOver})
	}()
	waitForControlState(t, m, a, false)
	close(gate.resume)
	<-engaged
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if env.controlled(userTab) {
		t.Fatal("delayed engagement overrode the user's takeover")
	}
}

func TestMoveDoesNotDisableReplacementControl(t *testing.T) {
	m, env, _ := makeWorld(t)
	a := hello(t, m, "proc:a", "tok-a", "a")
	b := hello(t, m, "proc:b", "tok-b", "b")
	share(t, m, a, false)
	gate := &delayedGateEnv{fakeEnv: env, entered: make(chan struct{}), resume: make(chan struct{})}
	m.env = gate
	done := make(chan error, 1)
	go func() {
		_, err := m.Share(context.Background(), "tab:t1", ShareRequest{BlockId: "p1", BrowserTabId: "user-tab", SessionId: b, Move: true})
		done <- err
	}()
	<-gate.entered
	m.lock.Lock()
	id := m.sessions[b].tabFor(userTab).id
	m.lock.Unlock()
	engaged := make(chan struct{})
	go func() { m.engageTab(b, id); close(engaged) }()
	waitForControlState(t, m, b, true)
	close(gate.resume)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	<-engaged
	if !env.controlled(userTab) {
		t.Fatal("delayed move disabled the new holder's control")
	}
}
