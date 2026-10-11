// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A one-shot wsh RPC client: one connection to wavesrv's socket, the same authentication as every wsh command (the
// terminal's token, checked by wavesrv), one request, then the connection closes. It speaks what pkg/wshutil speaks
// on a socket (one JSON message per line, pkg/wshutil/wshrpcio.go) without linking it.

// must match pkg/wshutil (ControlRoute and the authenticate command)
const (
	controlRoute       = "$control"
	authenticateCmd    = "authenticate"
	maxResponseLineLen = 1 << 20
)

// TokenClaims are the claims of a terminal's token (pkg/wavejwt.WaveJwtClaims) that the client reads, unverified as
// wsh reads them: wavesrv verifies the token itself when the client authenticates.
type TokenClaims struct {
	Sock    string `json:"sock,omitempty"`
	BlockId string `json:"blockid,omitempty"`
}

func ParseTokenClaims(token string) (TokenClaims, error) {
	var claims TokenClaims
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims, fmt.Errorf("error parsing token: not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return claims, fmt.Errorf("error parsing token: %w", err)
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return claims, fmt.Errorf("error parsing token: %w", err)
	}
	return claims, nil
}

type rpcMessage struct {
	Command string          `json:"command,omitempty"`
	ReqId   string          `json:"reqid,omitempty"`
	ResId   string          `json:"resid,omitempty"`
	Timeout int64           `json:"timeout,omitempty"`
	Route   string          `json:"route,omitempty"`
	Cont    bool            `json:"cont,omitempty"`
	Error   string          `json:"error,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type Client struct {
	conn   net.Conn
	reader *bufio.Reader
}

// Dial connects to the socket the token names and authenticates with it; the whole exchange ends by the deadline.
func Dial(token string, deadline time.Time) (*Client, error) {
	claims, err := ParseTokenClaims(token)
	if err != nil {
		return nil, err
	}
	if claims.Sock == "" {
		return nil, fmt.Errorf("sock claim is missing or invalid")
	}
	conn, err := dialSocket(expandHome(claims.Sock), deadline)
	if err != nil {
		return nil, err
	}
	c := &Client{conn: conn, reader: bufio.NewReaderSize(conn, 4096)}
	conn.SetDeadline(deadline)
	if _, err := c.Call(authenticateCmd, controlRoute, token, deadline); err != nil {
		conn.Close()
		return nil, fmt.Errorf("error authenticating: %w", err)
	}
	return c, nil
}

// dialSocket connects as pkg/wshutil.SetupDomainSocketRpcClient does: a host:port is a TCP socket, anything else a
// Unix domain socket at an absolute path.
func dialSocket(sockName string, deadline time.Time) (net.Conn, error) {
	if resolved, err := filepath.EvalSymlinks(sockName); err == nil {
		sockName = resolved
	}
	dialer := net.Dialer{Deadline: deadline}
	if _, err := net.ResolveTCPAddr("tcp", sockName); err == nil {
		if conn, err := dialer.Dial("tcp", sockName); err == nil {
			return conn, nil
		}
	}
	if !filepath.IsAbs(sockName) {
		return nil, fmt.Errorf("socket path must be absolute: %s", sockName)
	}
	conn, err := dialer.Dial("unix", sockName)
	if err != nil {
		return nil, fmt.Errorf("error setting up domain socket rpc client: %w", err)
	}
	return conn, nil
}

func expandHome(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~"))
}

// newReqId: wavesrv's router routes answers by request id across all its links, so ids are random uuids, as wsh's.
func newReqId() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// Call sends one request and returns its answer's data, or the error wavesrv answered.
func (c *Client) Call(command string, route string, data any, deadline time.Time) (json.RawMessage, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	reqId := newReqId()
	timeoutMs := max(time.Until(deadline).Milliseconds(), 1)
	msg, err := json.Marshal(rpcMessage{Command: command, ReqId: reqId, Timeout: timeoutMs, Route: route, Data: payload})
	if err != nil {
		return nil, err
	}
	c.conn.SetDeadline(deadline)
	if _, err := c.conn.Write(append(msg, '\n')); err != nil {
		return nil, err
	}
	for {
		line, err := c.readLine()
		if err != nil {
			return nil, err
		}
		var resp rpcMessage
		if json.Unmarshal(line, &resp) != nil || resp.ResId != reqId {
			continue
		}
		if resp.Error != "" {
			return nil, errors.New(resp.Error)
		}
		return resp.Data, nil
	}
}

func (c *Client) readLine() ([]byte, error) {
	var line []byte
	for {
		chunk, isPrefix, err := c.reader.ReadLine()
		if err != nil {
			return nil, err
		}
		line = append(line, chunk...)
		if len(line) > maxResponseLineLen {
			return nil, fmt.Errorf("answer too long")
		}
		if !isPrefix {
			return line, nil
		}
	}
}

func (c *Client) Close() {
	c.conn.Close()
}
