// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package remote

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

// #1831: a connection a server asked for refuses a loopback address at the dial itself, whatever the name resolved
// to when the guard checked it; the developer's own connections dial as before.
func TestServerRequestedDialRefusesLoopback(t *testing.T) {
	resetServerRequested := func() {
		serverRequestedLock.Lock()
		defer serverRequestedLock.Unlock()
		serverRequested = map[string]time.Time{}
	}
	resetServerRequested()
	t.Cleanup(resetServerRequested)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	opts := &SSHOpts{SSHHost: "rebind.example", SSHUser: "dev"}
	plain := net.Dialer{Control: moltenDialControl(moltenDialContext(context.Background(), opts))}
	conn, err := plain.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("an unmarked connection could not dial: %v", err)
	}
	conn.Close()
	MarkServerRequested("dev@rebind.example:22")
	marked := net.Dialer{Control: moltenDialControl(moltenDialContext(context.Background(), opts))}
	if conn, err := marked.Dial("tcp", listener.Addr().String()); err == nil || !strings.Contains(err.Error(), "refused") {
		if conn != nil {
			conn.Close()
		}
		t.Fatalf("a server's request dialed this computer: %v", err)
	}
	if err := dialRefuseLoopback("tcp", "203.0.113.7:22", nil); err != nil {
		t.Fatalf("a public address was refused: %v", err)
	}
	if err := dialRefuseLoopback("tcp", "[::1]:22", nil); err == nil {
		t.Fatal("::1 was dialed")
	}
}
