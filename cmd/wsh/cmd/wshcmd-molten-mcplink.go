// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The MCP servers' link to wavesrv (#1029, FR-BRW-008). An agent outlives MoltenTerm in a durable terminal, and so
// does the MCP server it started. Wave's socket client never ends its RPC client when the socket does (the input
// channel stays open), so after a MoltenTerm restart each request was queued to a dead writer and timed out with
// EC-TIME, forever, without reaching wavesrv. This link ends its client with the socket, reconnects on demand with the
// terminal's own token (never another credential), and fails at once with a sentence the agent can act on while
// MoltenTerm cannot be reached.

const (
	moltenMcpAuthTimeoutMs   = 5000
	moltenMcpProbeTimeoutMs  = 3000
	moltenMcpNoticeTimeoutMs = 5000
	moltenMcpRedialFirst     = 2 * time.Second
	moltenMcpRedialMax       = 30 * time.Second

	moltenMcpNotReachable = "MoltenTerm is not reachable from this session"
	moltenMcpTimeoutText  = "EC-TIME"
)

// moltenMcpLinkError: no link could be made; nothing was sent.
type moltenMcpLinkError struct {
	refused bool
	detail  string
}

func (e *moltenMcpLinkError) Error() string {
	if e.refused {
		return fmt.Sprintf("%s: it refused this terminal's credentials (%s). Quit the agent and start it again in a "+
			"MoltenTerm terminal: its new terminal brings valid credentials.", moltenMcpNotReachable, e.detail)
	}
	return fmt.Sprintf("%s: it is not running, or its socket does not answer (%s). Open MoltenTerm and call the tool "+
		"again: this server reconnects by itself.", moltenMcpNotReachable, e.detail)
}

// moltenMcpLostError: the link ended while a request waited for its answer, which may have been done.
type moltenMcpLostError struct{}

func (moltenMcpLostError) Error() string {
	return "MoltenTerm's link ended before it answered (MoltenTerm may have restarted); the server is connected again. " +
		"The action may have been done: check before doing it again."
}

type moltenMcpConn struct {
	rpc   *wshutil.WshRpc
	done  <-chan struct{}
	close func()
}

func (c *moltenMcpConn) ended() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

type moltenMcpDialFn func(token string) (*moltenMcpConn, error)

type moltenMcpLink struct {
	token string
	dial  moltenMcpDialFn
	// restored runs once the link is back after calls failed while it was down.
	restored    func(conn *moltenMcpConn, failed int)
	redialFirst time.Duration
	redialMax   time.Duration

	lock sync.Mutex
	conn *moltenMcpConn
	// gen counts the connections made: a session opened on one is unknown on the next.
	gen       int
	failed    int
	redialing bool
	closed    bool
	closeCh   chan struct{}
}

func makeMoltenMcpLink(token string, dial moltenMcpDialFn) *moltenMcpLink {
	return &moltenMcpLink{token: token, dial: dial, redialFirst: moltenMcpRedialFirst, redialMax: moltenMcpRedialMax,
		closeCh: make(chan struct{})}
}

// get returns a live connection and its generation, connecting again when the last one ended.
func (l *moltenMcpLink) get() (*moltenMcpConn, int, error) {
	conn, gen, failed, err := l.getLocked()
	if err != nil {
		return nil, 0, err
	}
	if failed > 0 && l.restored != nil {
		go l.restored(conn, failed)
	}
	return conn, gen, nil
}

func (l *moltenMcpLink) getLocked() (*moltenMcpConn, int, int, error) {
	l.lock.Lock()
	defer l.lock.Unlock()
	if l.closed {
		return nil, 0, 0, &moltenMcpLinkError{detail: "this server is closing"}
	}
	if l.conn != nil && !l.conn.ended() && !l.conn.rpc.IsServerDone() {
		return l.conn, l.gen, 0, nil
	}
	if l.conn != nil {
		l.conn.close()
		l.conn = nil
	}
	conn, err := l.dial(l.token)
	if err != nil {
		return nil, 0, 0, err
	}
	l.conn = conn
	l.gen++
	failed := l.failed
	l.failed = 0
	return conn, l.gen, failed, nil
}

// current is the live connection, nil when there is none; it never connects.
func (l *moltenMcpLink) current() *moltenMcpConn {
	l.lock.Lock()
	defer l.lock.Unlock()
	if l.conn == nil || l.conn.ended() || l.conn.rpc.IsServerDone() {
		return nil
	}
	return l.conn
}

func moltenMcpOpts(route string, timeoutMs int64) *wshrpc.RpcOpts {
	return &wshrpc.RpcOpts{Route: route, Timeout: timeoutMs}
}

// drop ends a connection that stopped answering, so the next request connects again.
func (l *moltenMcpLink) drop(conn *moltenMcpConn) {
	l.lock.Lock()
	defer l.lock.Unlock()
	conn.close()
	if l.conn == conn {
		l.conn = nil
	}
}

// noteFailed counts a call the agent saw fail for want of a link, and keeps reconnecting in the background so the
// developer learns when the link is back.
func (l *moltenMcpLink) noteFailed() {
	l.lock.Lock()
	defer l.lock.Unlock()
	l.failed++
	if l.redialing || l.closed {
		return
	}
	l.redialing = true
	go l.redialLoop()
}

func (l *moltenMcpLink) setRedialing(on bool) {
	l.lock.Lock()
	defer l.lock.Unlock()
	l.redialing = on
}

func (l *moltenMcpLink) redialLoop() {
	defer l.setRedialing(false)
	delay := l.redialFirst
	for {
		timer := time.NewTimer(delay)
		select {
		case <-l.closeCh:
			timer.Stop()
			return
		case <-timer.C:
		}
		if _, _, err := l.get(); err == nil {
			return
		}
		delay = min(delay*2, l.redialMax)
	}
}

func (l *moltenMcpLink) close() {
	l.lock.Lock()
	defer l.lock.Unlock()
	if l.closed {
		return
	}
	l.closed = true
	close(l.closeCh)
	if l.conn != nil {
		l.conn.close()
		l.conn = nil
	}
}

type moltenMcpAnswer struct {
	data any
	err  error
}

// once sends one request on the current connection. lost: the link failed under it; sent: the request may have
// reached wavesrv.
func (l *moltenMcpLink) once(ctx context.Context, command string, data any, route string, timeoutMs int64) (resp any, gen int, err error, lost bool, sent bool) {
	conn, gen, err := l.get()
	if err != nil {
		return nil, 0, err, false, false
	}
	handler, err := conn.rpc.SendComplexRequest(command, data, &wshrpc.RpcOpts{Route: route, Timeout: timeoutMs})
	// SendComplexRequest recovers the panic of a send on the output the ending client just closed.
	recovered := handler == nil && err == nil
	if recovered {
		err = errors.New("the link to MoltenTerm ended while sending")
	}
	if err != nil {
		if recovered || conn.ended() || conn.rpc.IsServerDone() {
			l.drop(conn)
			return nil, gen, err, true, false
		}
		return nil, gen, err, false, false
	}
	answerCh := make(chan moltenMcpAnswer, 1)
	go func() {
		data, err := handler.NextResponse()
		answerCh <- moltenMcpAnswer{data: data, err: err}
	}()
	var answer moltenMcpAnswer
	select {
	case answer = <-answerCh:
	case <-conn.done:
		select {
		case answer = <-answerCh:
		default:
			l.drop(conn)
			return nil, gen, moltenMcpLostError{}, true, true
		}
	case <-ctx.Done():
		cancelCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		handler.SendCancel(cancelCtx)
		return nil, gen, errors.New("Cancelled"), false, true
	}
	if answer.err == nil {
		return answer.data, gen, nil, false, true
	}
	if !strings.Contains(answer.err.Error(), moltenMcpTimeoutText) {
		return nil, gen, answer.err, false, true
	}
	// A timeout on a link that still answers is wavesrv's own slowness; on one that does not, the link is dead.
	if _, probeErr := wshclient.ControlGetRouteIdCommand(conn.rpc, &wshrpc.RpcOpts{Route: wshutil.ControlRoute, Timeout: moltenMcpProbeTimeoutMs}); probeErr == nil {
		return nil, gen, fmt.Errorf("MoltenTerm did not answer in time (%v); its link is up: try again", answer.err), false, true
	}
	l.drop(conn)
	return nil, gen, moltenMcpLostError{}, true, true
}

// call sends a request, on a new link when the current one is dead. A request that never left is sent again; one that
// may have reached wavesrv only when replaying it is harmless (readOnly). Failures for want of a link count toward the
// developer's notice.
func (l *moltenMcpLink) call(ctx context.Context, command string, data any, route string, timeoutMs int64, readOnly bool) (any, int, error) {
	for attempt := 0; ; attempt++ {
		resp, gen, err, lost, sent := l.once(ctx, command, data, route, timeoutMs)
		if err == nil {
			return resp, gen, nil
		}
		var linkErr *moltenMcpLinkError
		if errors.As(err, &linkErr) {
			l.noteFailed()
			return nil, gen, err
		}
		if !lost {
			return nil, gen, err
		}
		if attempt == 0 && (!sent || readOnly) {
			continue
		}
		l.noteFailed()
		if !sent {
			return nil, gen, &moltenMcpLinkError{detail: err.Error()}
		}
		return nil, gen, err
	}
}

// moltenMcpDial connects to the socket the terminal's token names and authenticates with that token, like
// setupRpcClient, with a client that ends when the socket does.
func moltenMcpDial(token string) (*moltenMcpConn, error) {
	sockName, err := wshutil.ExtractUnverifiedSocketName(token)
	if err != nil {
		return nil, &moltenMcpLinkError{refused: true, detail: err.Error()}
	}
	sockName = wavebase.ExpandHomeDirSafe(sockName)
	if resolved, err := filepath.EvalSymlinks(sockName); err == nil {
		sockName = resolved
	}
	netConn, err := net.Dial("unix", sockName)
	if err != nil {
		return nil, &moltenMcpLinkError{detail: err.Error()}
	}
	conn := moltenMcpConnOf(netConn)
	_, err = wshclient.AuthenticateCommand(conn.rpc, token, &wshrpc.RpcOpts{Route: wshutil.ControlRoute, Timeout: moltenMcpAuthTimeoutMs})
	if err != nil {
		conn.close()
		if conn.ended() || strings.Contains(err.Error(), moltenMcpTimeoutText) {
			return nil, &moltenMcpLinkError{detail: err.Error()}
		}
		return nil, &moltenMcpLinkError{refused: true, detail: err.Error()}
	}
	if blockId := os.Getenv("WAVETERM_BLOCKID"); blockId != "" {
		wshclient.SetPeerInfoCommand(conn.rpc, fmt.Sprintf("domain:block:%s", blockId), &wshrpc.RpcOpts{Route: wshutil.ControlRoute})
	}
	return conn, nil
}

// moltenMcpConnOf wraps a socket in an RPC client whose input closes with the socket, which ends the client: later
// requests fail at once, and done says the link is gone.
func moltenMcpConnOf(netConn net.Conn) *moltenMcpConn {
	inputCh := make(chan baseds.RpcInputChType, wshutil.DefaultInputChSize)
	outputCh := make(chan []byte, wshutil.DefaultOutputChSize)
	done := make(chan struct{})
	var closeOnce sync.Once
	closeConn := func() { closeOnce.Do(func() { netConn.Close() }) }
	go func() {
		defer close(done)
		defer close(inputCh)
		defer closeConn()
		err := wshutil.AdaptStreamToMsgCh(netConn, inputCh, nil)
		if err != nil && err != io.EOF && !errors.Is(err, net.ErrClosed) {
			fmt.Fprintf(os.Stderr, "molten mcp: link to MoltenTerm ended: %v\n", err)
		}
	}()
	go func() {
		if err := wshutil.AdaptOutputChToStream(outputCh, netConn); err != nil {
			closeConn()
		}
	}()
	rpc := wshutil.MakeWshRpcWithChannels(inputCh, outputCh, wshrpc.RpcContext{}, nil, "molten-mcp")
	return &moltenMcpConn{rpc: rpc, done: done, close: closeConn}
}
