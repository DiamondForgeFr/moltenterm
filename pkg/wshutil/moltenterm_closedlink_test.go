// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import (
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

const closedLinkTestDeadline = time.Minute

func closedLinkBacklogLen(router *WshRouter, linkId baseds.LinkId) int {
	router.lock.Lock()
	defer router.lock.Unlock()
	return len(router.linkMsgBacklog[linkId])
}

func closedLinkIsRegistered(router *WshRouter, linkId baseds.LinkId) bool {
	router.lock.Lock()
	defer router.lock.Unlock()
	return router.linkMap[linkId] != nil
}

func waitClosedLinkCondition(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(closedLinkTestDeadline)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: still not true after %v", what, closedLinkTestDeadline)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// fillProxyBacklog registers a proxy that holds one message and has a backlog behind it, as a busy link does.
func fillProxyBacklog(t *testing.T, router *WshRouter) (*WshRpcProxy, baseds.LinkId) {
	t.Helper()
	proxy := MakeRpcProxyWithSize("test", 1, 1)
	linkId := router.RegisterUntrustedLink(proxy)
	for i := 0; i < 3; i++ {
		router.sendRpcMessageToLink(linkId, proxy, []byte(`{"command":"test"}`), baseds.NoLinkId, "test")
	}
	if n := closedLinkBacklogLen(router, linkId); n == 0 {
		t.Fatal("the link has no backlog: the case this guards is not set up")
	}
	return proxy, linkId
}

// #2334: a link whose proxy channel was closed while it stayed registered kept its backlog. Every 50 ms the router
// retried it, each send panicked on the closed channel and printed a stack trace while holding the router lock: the
// log grew by gigabytes and every RPC slowed down. One round now drops the backlog and unregisters the link.
func TestClosedChannelBacklogIsDroppedInOneRound(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	proxy, linkId := fillProxyBacklog(t, router)
	// a raw close, as the domain-socket client did; under the proxy's lock so that it does not race the router's send
	proxy.Lock.Lock()
	close(proxy.ToRemoteCh)
	proxy.Lock.Unlock()
	router.processOneBacklogRound()
	if n := closedLinkBacklogLen(router, linkId); n != 0 {
		t.Fatalf("the closed link still has %d messages in its backlog after a round", n)
	}
	waitClosedLinkCondition(t, "the closed link is unregistered", func() bool { return !closedLinkIsRegistered(router, linkId) })
}

func TestClosedProxyRefusesSends(t *testing.T) {
	t.Parallel()
	proxy := MakeRpcProxyWithSize("test", 1, 1)
	proxy.Close()
	proxy.Close()
	if !proxy.IsClosed() {
		t.Fatal("a closed proxy does not read as closed")
	}
	if proxy.SendRpcMessage([]byte(`{}`), baseds.NoLinkId, "test") {
		t.Fatal("a closed proxy accepted a message")
	}
}

func TestBacklogOfAClosedProxyIsDropped(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	proxy, linkId := fillProxyBacklog(t, router)
	proxy.Close()
	router.processOneBacklogRound()
	if n := closedLinkBacklogLen(router, linkId); n != 0 {
		t.Fatalf("the closed link still has %d messages in its backlog after a round", n)
	}
	waitClosedLinkCondition(t, "the closed link is unregistered", func() bool { return !closedLinkIsRegistered(router, linkId) })
}

func TestMessageForAClosedLinkIsNotBacklogged(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	proxy := MakeRpcProxyWithSize("test", 1, 1)
	linkId := router.RegisterUntrustedLink(proxy)
	proxy.Close()
	router.sendRpcMessageToLink(linkId, proxy, []byte(`{"command":"test"}`), baseds.NoLinkId, "test")
	if n := closedLinkBacklogLen(router, linkId); n != 0 {
		t.Fatalf("a message for a closed link went to its backlog (%d messages)", n)
	}
	waitClosedLinkCondition(t, "the closed link is unregistered", func() bool { return !closedLinkIsRegistered(router, linkId) })
}

func TestBacklogDrainsInOrderToASlowLink(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	proxy := MakeRpcProxyWithSize("test", 1, 1)
	linkId := router.RegisterUntrustedLink(proxy)
	const count = 6
	for i := 0; i < count; i++ {
		router.sendRpcMessageToLink(linkId, proxy, []byte{byte('0' + i)}, baseds.NoLinkId, "test")
	}
	deadline := time.After(closedLinkTestDeadline)
	for i := 0; i < count; i++ {
		select {
		case msg := <-proxy.ToRemoteCh:
			if string(msg) != string([]byte{byte('0' + i)}) {
				t.Fatalf("message %d arrived as %q", i, msg)
			}
		case <-deadline:
			t.Fatalf("message %d never arrived", i)
		}
	}
	waitClosedLinkCondition(t, "the backlog is cleared", func() bool { return closedLinkBacklogLen(router, linkId) == 0 })
}

// blockingTestClient refuses its first message, so that the next ones go to the backlog, then blocks every send until
// release is closed.
type blockingTestClient struct {
	refusedFirst atomic.Bool
	entered      chan struct{}
	enteredOnce  sync.Once
	release      chan struct{}
	recv         chan []byte
}

func (c *blockingTestClient) GetPeerInfo() string { return "blocking" }

func (c *blockingTestClient) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	if c.refusedFirst.CompareAndSwap(false, true) {
		return false
	}
	c.enteredOnce.Do(func() { close(c.entered) })
	<-c.release
	return true
}

func (c *blockingTestClient) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-c.recv
	return msg, ok
}

func TestBacklogSendDoesNotHoldTheRouterLock(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	client := &blockingTestClient{entered: make(chan struct{}), release: make(chan struct{}), recv: make(chan []byte)}
	t.Cleanup(func() { close(client.recv) })
	released := false
	release := func() {
		if !released {
			released = true
			close(client.release)
		}
	}
	t.Cleanup(release)
	linkId := router.RegisterUntrustedLink(client)
	router.sendRpcMessageToLink(linkId, client, []byte(`{"command":"test"}`), baseds.NoLinkId, "test")
	select {
	case <-client.entered:
	case <-time.After(closedLinkTestDeadline):
		t.Fatal("the backlog round never sent")
	}
	lockFree := make(chan struct{})
	go func() {
		router.getLinkMeta(linkId)
		close(lockFree)
	}()
	select {
	case <-lockFree:
	case <-time.After(closedLinkTestDeadline):
		t.Fatal("the router lock is held while a backlog send blocks")
	}
	release()
	waitClosedLinkCondition(t, "the backlog is cleared", func() bool { return closedLinkBacklogLen(router, linkId) == 0 })
}

func TestBacklogLogIsRateLimitedPerLink(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	router.lock.Lock()
	defer router.lock.Unlock()
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if !router.allowBacklogLog_withlock(1, backlogLogReached, start) {
		t.Fatal("the first line is refused")
	}
	if router.allowBacklogLog_withlock(1, backlogLogReached, start.Add(30*time.Second)) {
		t.Fatal("a second line within a minute is allowed")
	}
	if !router.allowBacklogLog_withlock(1, backlogLogCleared, start.Add(30*time.Second)) {
		t.Fatal("another kind of line is refused")
	}
	if !router.allowBacklogLog_withlock(2, backlogLogReached, start.Add(30*time.Second)) {
		t.Fatal("another link's line is refused")
	}
	if !router.allowBacklogLog_withlock(1, backlogLogReached, start.Add(BacklogLogInterval)) {
		t.Fatal("a line a minute later is refused")
	}
}

// Serial: handleDomainSocketClient registers on DefaultRouter, a package-level router this test replaces.
func TestDomainSocketClientClosingAtOnceLeavesNoLink(t *testing.T) {
	saved := DefaultRouter
	DefaultRouter = NewWshRouter()
	router := DefaultRouter
	t.Cleanup(func() { DefaultRouter = saved })
	router.lock.Lock()
	baseLinks := len(router.linkMap)
	router.lock.Unlock()
	const conns = 50
	for i := 0; i < conns; i++ {
		server, client := net.Pipe()
		client.Close()
		handleDomainSocketClient(server, "", nil)
	}
	waitClosedLinkCondition(t, "every closed connection is unregistered", func() bool {
		router.lock.Lock()
		defer router.lock.Unlock()
		return len(router.linkMap) == baseLinks && int(router.nextLinkId) >= baseLinks+conns
	})
}
