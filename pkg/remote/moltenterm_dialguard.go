// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package remote

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"syscall"
	"time"
)

// A connection a server asked this computer to open (#1831) never dials this computer's own SSH server: the guard
// checks the name and what it resolves to, and the dial checks the address it actually connects to, so a DNS answer
// that changes in between does not get through.

const serverRequestedTTL = 5 * time.Minute

var serverRequestedLock sync.Mutex
var serverRequested = map[string]time.Time{}

func normDialConnName(name string) string {
	return strings.TrimSuffix(name, ":22")
}

// MarkServerRequested records that a server asked for the connection connName: its dials in the next minutes refuse
// a loopback address.
func MarkServerRequested(connName string) {
	serverRequestedLock.Lock()
	defer serverRequestedLock.Unlock()
	serverRequested[normDialConnName(connName)] = time.Now().Add(serverRequestedTTL)
}

func isServerRequested(connName string) bool {
	serverRequestedLock.Lock()
	defer serverRequestedLock.Unlock()
	expires, ok := serverRequested[normDialConnName(connName)]
	if !ok {
		return false
	}
	if time.Now().After(expires) {
		delete(serverRequested, normDialConnName(connName))
		return false
	}
	return true
}

type serverRequestedKey struct{}

// moltenDialContext marks ctx when opts is a connection a server asked for.
func moltenDialContext(ctx context.Context, opts *SSHOpts) context.Context {
	if opts == nil || !isServerRequested(opts.String()) {
		return ctx
	}
	return context.WithValue(ctx, serverRequestedKey{}, true)
}

// moltenDialControl is the dialer's Control for a marked ctx: it refuses a loopback or unspecified address.
func moltenDialControl(ctx context.Context) func(network string, address string, c syscall.RawConn) error {
	if marked, _ := ctx.Value(serverRequestedKey{}).(bool); !marked {
		return nil
	}
	return dialRefuseLoopback
}

func dialRefuseLoopback(_ string, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	ip := net.ParseIP(host)
	if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
		return fmt.Errorf("refused: a server asked this computer to connect to %s, which is this computer", address)
	}
	return nil
}
