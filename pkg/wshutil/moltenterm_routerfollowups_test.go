// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import (
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

// refusingTestClient never accepts a message and is never closed: its backlog only grows.
type refusingTestClient struct {
	recv chan []byte
}

func (c *refusingTestClient) GetPeerInfo() string { return "refusing" }

func (c *refusingTestClient) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	return false
}

func (c *refusingTestClient) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-c.recv
	return msg, ok
}

func linkProxy(t *testing.T, router *WshRouter, linkId baseds.LinkId) *WshRpcProxy {
	t.Helper()
	router.lock.Lock()
	defer router.lock.Unlock()
	lm := router.linkMap[linkId]
	if lm == nil {
		t.Fatalf("link %d is not registered", linkId)
	}
	proxy, ok := lm.client.(*WshRpcProxy)
	if !ok {
		t.Fatalf("link %d is not a proxy", linkId)
	}
	return proxy
}

// #2340: a request routed to a link found closed waited for its timeout; it is now answered with an error at once.
func TestRequestToAGoneLinkIsAnsweredAtOnce(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	caller := MakeRpcProxyWithSize("caller", 10, 10)
	if _, err := router.RegisterTrustedLeaf(caller, "proc:caller-2340"); err != nil {
		t.Fatal(err)
	}
	dest := MakeRpcProxyWithSize("dest", 10, 10)
	if _, err := router.RegisterTrustedLeaf(dest, "proc:dest-2340"); err != nil {
		t.Fatal(err)
	}
	dest.Close()
	reqBytes, _ := json.Marshal(RpcMessage{Command: "test", ReqId: "req-2340", Route: "proc:dest-2340"})
	caller.FromRemoteCh <- baseds.RpcInputChType{MsgBytes: reqBytes}
	select {
	case respBytes := <-caller.ToRemoteCh:
		var resp RpcMessage
		if err := json.Unmarshal(respBytes, &resp); err != nil {
			t.Fatal(err)
		}
		if resp.ResId != "req-2340" || resp.Error == "" {
			t.Fatalf("the answer is not an error for the request: %s", respBytes)
		}
	case <-time.After(closedLinkTestDeadline):
		t.Fatal("a request to a gone link got no answer")
	}
}

// #2340: the "reached N messages" line was rate-limited per link for a minute, which also hid a higher size.
func TestHigherBacklogSizeIsLoggedWithinTheMinute(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	client := &refusingTestClient{recv: make(chan []byte)}
	t.Cleanup(func() { close(client.recv) })
	linkId := router.RegisterUntrustedLink(client)
	router.lock.Lock()
	defer router.lock.Unlock()
	fill := func(count int) []string {
		var lines []string
		for i := 0; i < count; i++ {
			if line := router.addToBacklog_withlock(linkId, []byte(`{}`), baseds.NoLinkId, "test"); line != "" {
				lines = append(lines, line)
			}
		}
		return lines
	}
	clearBacklog := func() {
		delete(router.linkMsgBacklog, linkId)
		delete(router.backlogHighWaterMark, linkId)
	}
	if lines := fill(1); len(lines) != 1 || !strings.HasSuffix(lines[0], "reached 1 messages") {
		t.Fatalf("first fill logged %q", lines)
	}
	clearBacklog()
	lines := fill(5)
	if len(lines) != 1 || !strings.HasSuffix(lines[0], "reached 5 messages") {
		t.Fatalf("a refill to a higher size within the minute logged %q, want only the higher size", lines)
	}
	clearBacklog()
	if lines := fill(5); len(lines) != 0 {
		t.Fatalf("a refill to the same size within the minute logged %q", lines)
	}
}

func TestBacklogSizeLogRateLimit(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	router.lock.Lock()
	defer router.lock.Unlock()
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if !router.allowBacklogSizeLog_withlock(1, 10, start) {
		t.Fatal("the first size is refused")
	}
	if router.allowBacklogSizeLog_withlock(1, 5, start.Add(10*time.Second)) {
		t.Fatal("a lower size within the minute is allowed")
	}
	if router.allowBacklogSizeLog_withlock(1, 10, start.Add(10*time.Second)) {
		t.Fatal("the same size within the minute is allowed")
	}
	if !router.allowBacklogSizeLog_withlock(1, 20, start.Add(20*time.Second)) {
		t.Fatal("a higher size within the minute is refused")
	}
	if !router.allowBacklogSizeLog_withlock(1, 1, start.Add(20*time.Second+BacklogLogInterval)) {
		t.Fatal("a lower size a minute later is refused")
	}
}

// #2340: each message to a gone link started its own unregister.
func TestOneUnregisterPerGoneLink(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	proxy := MakeRpcProxyWithSize("test", 1, 1)
	linkId := router.RegisterUntrustedLink(proxy)
	router.lock.Lock()
	first := router.claimGoneLinkUnregister_withlock(linkId)
	second := router.claimGoneLinkUnregister_withlock(linkId)
	router.lock.Unlock()
	if !first || second {
		t.Fatalf("claims of one link: first %v, second %v; want only the first", first, second)
	}
	router.unregisterGoneLink(linkId)
	router.lock.Lock()
	afterUnregister := router.claimGoneLinkUnregister_withlock(linkId)
	pending := len(router.unregisteringLinks)
	router.lock.Unlock()
	if afterUnregister {
		t.Fatal("an unregistered link can be claimed again")
	}
	if pending != 0 {
		t.Fatalf("%d unregisters still recorded after the unregister", pending)
	}
}

func TestMessagesToAGoneLinkLeaveNoPendingUnregister(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	proxy := MakeRpcProxyWithSize("test", 1, 1)
	linkId := router.RegisterUntrustedLink(proxy)
	proxy.Close()
	for i := 0; i < 20; i++ {
		if router.sendRpcMessageToLink(linkId, proxy, []byte(`{"command":"test"}`), baseds.NoLinkId, "test") {
			t.Fatal("a message to a closed link reads as sent")
		}
	}
	waitClosedLinkCondition(t, "the gone link is unregistered and nothing is pending", func() bool {
		router.lock.Lock()
		defer router.lock.Unlock()
		return router.linkMap[linkId] == nil && len(router.unregisteringLinks) == 0
	})
}

// #2340: connserver's listener connections never closed their proxy, whose writer then waited forever.
func TestServedLinkConnClosesItsProxy(t *testing.T) {
	t.Parallel()
	router := NewWshRouter()
	server, client := net.Pipe()
	linkId := ServeRpcLinkConn(router, server, "test", "", nil)
	proxy := linkProxy(t, router, linkId)
	client.Close()
	waitClosedLinkCondition(t, "the link is unregistered and its proxy closed", func() bool {
		return !closedLinkIsRegistered(router, linkId) && proxy.IsClosed()
	})
}

// Serial: HandleConnStdIOClient registers on DefaultRouter, a package-level router this test replaces.
func TestStdIOClientClosesItsProxy(t *testing.T) {
	saved := DefaultRouter
	DefaultRouter = NewWshRouter()
	router := DefaultRouter
	t.Cleanup(func() { DefaultRouter = saved })
	input := make(chan utilfn.LineOutput)
	done := make(chan struct{})
	go func() {
		defer close(done)
		HandleConnStdIOClient("stdio-2340", "", input, io.Discard)
	}()
	var proxy *WshRpcProxy
	var linkId baseds.LinkId
	waitClosedLinkCondition(t, "the stdio link is registered", func() bool {
		router.lock.Lock()
		defer router.lock.Unlock()
		for id, lm := range router.linkMap {
			if p, ok := lm.client.(*WshRpcProxy); ok && p.GetPeerInfo() == "stdio-2340" {
				proxy, linkId = p, id
				return true
			}
		}
		return false
	})
	close(input)
	select {
	case <-done:
	case <-time.After(closedLinkTestDeadline):
		t.Fatal("HandleConnStdIOClient did not return after its input ended")
	}
	if !proxy.IsClosed() {
		t.Fatal("the stdio proxy is still open after its input ended")
	}
	if closedLinkIsRegistered(router, linkId) {
		t.Fatal("the stdio link is still registered after its input ended")
	}
}
