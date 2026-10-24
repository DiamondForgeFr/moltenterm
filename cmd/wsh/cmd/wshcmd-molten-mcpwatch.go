// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// The server tells MoltenTerm about its link (#1050, FR-CONT-022, DS-CONT-031): the terminal's connections menu shows
// it and the developer's Reconnect reaches it. A watch request stays open on wavesrv's link registry, renewed when
// wavesrv answers it; each new connection reports first, before any call, so a link the developer stopped is known
// before its calls arrive. When the link ends the watch reconnects in the background, so after a MoltenTerm restart
// the menu sees the server again by itself. Only MCP's initialize (client name and version) and the server's own
// state are reported: any agent is seen the same way.

const (
	moltenMcpWatchReportTimeoutMs = 5000
	moltenMcpWatchMarginMs        = 10000
	moltenMcpByeLinkTimeoutMs     = 2000
	moltenMcpWatchRetryFirst      = 2 * time.Second
	moltenMcpWatchRetryMax        = 30 * time.Second
)

// moltenMcpUpdates wraps the server's in-place re-execution (#1049) to tell the menu whether a new program waits on
// disk and why the last switch did not happen.
type moltenMcpUpdates struct {
	inner   mcpbrowser.Reexec
	lock    sync.Mutex
	blocked string
}

func makeMoltenMcpUpdates(inner mcpbrowser.Reexec) *moltenMcpUpdates {
	if inner == nil {
		return nil
	}
	return &moltenMcpUpdates{inner: inner}
}

func (u *moltenMcpUpdates) Changed() bool {
	u.lock.Lock()
	defer u.lock.Unlock()
	return u.inner.Changed()
}

func (u *moltenMcpUpdates) Exec(state mcpbrowser.ResumeState, pending []byte) error {
	u.lock.Lock()
	defer u.lock.Unlock()
	err := u.inner.Exec(state, pending)
	if err != nil {
		u.blocked = err.Error()
	}
	return err
}

func (u *moltenMcpUpdates) status() (bool, string) {
	if u == nil {
		return false, ""
	}
	u.lock.Lock()
	defer u.lock.Unlock()
	return u.inner.Changed(), u.blocked
}

func (b *moltenMcpRpcBackend) watchReport(stats moltenMcpLinkStats, holdMs int) agentlinkwire.WatchRequest {
	client := b.clientInfo()
	pending, blocked := b.updates.status()
	req := agentlinkwire.WatchRequest{
		Token: b.token, Server: b.protocol.server, Pid: os.Getpid(), AgentPid: os.Getppid(),
		ClientName: client.Name, ClientVersion: client.Version, Version: wavebase.WaveVersion,
		Failed: stats.failed, LastError: stats.lastErr, UpdatePending: pending, UpdateBlocked: blocked, HoldMs: holdMs,
	}
	if !stats.lastErrAt.IsZero() {
		req.LastErrorAt = stats.lastErrAt.UnixMilli()
	}
	return req
}

// reportOnConnect runs under the link's lock, on a connection nothing else uses yet.
func (b *moltenMcpRpcBackend) reportOnConnect(conn *moltenMcpConn, stats moltenMcpLinkStats) {
	opts := moltenMcpOpts(agentlinkwire.RouteId, moltenMcpWatchReportTimeoutMs)
	if _, err := conn.rpc.SendRpcRequest(agentlinkwire.WatchCommand, b.watchReport(stats, 0), opts); err != nil {
		fmt.Fprintf(os.Stderr, "%s: MoltenTerm's connections menu was not told about this server: %v\n", b.protocol.name, err)
	}
}

func (b *moltenMcpRpcBackend) startWatch() {
	b.watchOnce.Do(func() { go b.watchLoop() })
}

// waitOrClosed waits d; false: the server is closing.
func (b *moltenMcpRpcBackend) waitOrClosed(d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-b.link.closeCh:
		return false
	case <-timer.C:
		return true
	}
}

func (b *moltenMcpRpcBackend) watchLoop() {
	delay := moltenMcpWatchRetryFirst
	for {
		select {
		case <-b.link.closeCh:
			return
		default:
		}
		conn, _, err := b.link.get()
		if err != nil {
			if !b.waitOrClosed(delay) {
				return
			}
			delay = min(delay*2, moltenMcpWatchRetryMax)
			continue
		}
		delay = moltenMcpWatchRetryFirst
		resp, err, ended := b.holdWatch(conn)
		if ended {
			b.link.drop(conn)
			continue
		}
		if err != nil {
			// A MoltenTerm without the registry, or one that refused the report: the calls go on, the menu waits.
			if !b.waitOrClosed(moltenMcpWatchRetryMax) {
				return
			}
			continue
		}
		var result agentlinkwire.WatchResult
		if err := utilfn.ReUnmarshal(&result, resp); err != nil {
			continue
		}
		if result.Action == agentlinkwire.ActionReconnect {
			fmt.Fprintf(os.Stderr, "%s: the developer asked for a new link to MoltenTerm\n", b.protocol.name)
			b.link.drop(conn)
			b.setSession("", 0, "")
		}
	}
}

// holdWatch holds one watch; ended: the connection went under it (a pending answer does not end with the socket,
// wshcmd-molten-mcplink.go).
func (b *moltenMcpRpcBackend) holdWatch(conn *moltenMcpConn) (any, error, bool) {
	opts := moltenMcpOpts(agentlinkwire.RouteId, agentlinkwire.WatchHoldMs+moltenMcpWatchMarginMs)
	handler, err := conn.rpc.SendComplexRequest(agentlinkwire.WatchCommand, b.watchReport(b.link.stats(), agentlinkwire.WatchHoldMs), opts)
	if handler == nil && err == nil {
		return nil, nil, true
	}
	if err != nil {
		return nil, err, conn.ended() || conn.rpc.IsServerDone()
	}
	answerCh := make(chan moltenMcpAnswer, 1)
	go func() {
		data, err := handler.NextResponse()
		answerCh <- moltenMcpAnswer{data: data, err: err}
	}()
	select {
	case answer := <-answerCh:
		return answer.data, answer.err, answer.err != nil && (conn.ended() || conn.rpc.IsServerDone())
	case <-conn.done:
		return nil, nil, true
	case <-b.link.closeCh:
		return nil, nil, false
	}
}

// byeLink takes the server out of the connections menu as it ends with its agent's session.
func (b *moltenMcpRpcBackend) byeLink() {
	conn := b.link.current()
	if conn == nil {
		return
	}
	req := agentlinkwire.ByeRequest{Token: b.token, Server: b.protocol.server, Pid: os.Getpid()}
	conn.rpc.SendRpcRequest(agentlinkwire.ByeCommand, req, moltenMcpOpts(agentlinkwire.RouteId, moltenMcpByeLinkTimeoutMs))
}
