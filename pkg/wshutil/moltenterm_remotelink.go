// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// An SSH or WSL host reaches wavesrv through its connection's link: nothing it runs may start a process or open a
// path on this computer (NFR-FORK-001 (12), #1831). The link remembers the connection the host's token named, never
// what a request says.

// MoltenRequestGuard, when set (wavesrv sets it at start), runs before every request a WshRpc of this process
// answers: it refuses the request with an error, or returns the data the handler gets (rewritten or as is).
var MoltenRequestGuard func(ctx context.Context, command string, data any) (any, error)

// HandleStdIOClient serves a router link over stdio whose connection is unknown.
func HandleStdIOClient(logName string, input chan utilfn.LineOutput, output io.Writer) {
	HandleConnStdIOClient(logName, "", input, output)
}

func isRemoteConnName(connName string) bool {
	return connName != "" && connName != wshrpc.LocalConnName && !strings.HasPrefix(connName, wshrpc.LocalConnName+":")
}

func (router *WshRouter) setLinkConn(linkId baseds.LinkId, connName string) {
	if !isRemoteConnName(connName) {
		return
	}
	router.lock.Lock()
	defer router.lock.Unlock()
	if lm := router.linkMap[linkId]; lm != nil {
		lm.connName = connName
	}
}

// RemoteLinkConn tells whether ingressLinkId is an SSH or WSL host's link: a trusted router link other than the
// windows' websocket, or a leaf whose token named a remote connection. It also returns the connection the link
// authenticated for, "" when unknown. Takes the router's lock: never call it from SendRpcMessage.
func (router *WshRouter) RemoteLinkConn(ingressLinkId baseds.LinkId) (string, bool) {
	if ingressLinkId == baseds.NoLinkId {
		return "", false
	}
	router.lock.Lock()
	defer router.lock.Unlock()
	return router.remoteLinkConn_withlock(ingressLinkId)
}

func (router *WshRouter) remoteLinkConn_withlock(linkId baseds.LinkId) (string, bool) {
	lm := router.linkMap[linkId]
	if lm == nil || !lm.trusted || lm.isWindow || lm.inProcess {
		return "", false
	}
	if lm.linkKind == LinkKind_Router || lm.connName != "" {
		return lm.connName, true
	}
	return "", false
}

// NormConnName is a connection name compared to another: "" and "local" are this computer, and an SSH name may
// carry the default port.
func NormConnName(name string) string {
	if !isRemoteConnName(name) {
		return wshrpc.LocalConnName
	}
	return strings.TrimSuffix(name, ":22")
}

type remoteReadGrant struct {
	conn  string
	route string
	path  string
}

var remoteReadGrantsLock sync.Mutex
var remoteReadGrants = map[remoteReadGrant]int{}

// GrantRemoteRead lets the host of destConn read srcPath from srcConn's server while a copy wavesrv started runs:
// a copy between two connections is pulled by the destination's server (RemoteFileCopy), the only time a host reads
// another connection's file. revoke ends the grant.
func GrantRemoteRead(destConn string, srcConn string, srcPath string) (revoke func()) {
	grant := remoteReadGrant{conn: NormConnName(destConn), route: MakeConnectionRouteId(srcConn), path: srcPath}
	remoteReadGrantsLock.Lock()
	defer remoteReadGrantsLock.Unlock()
	remoteReadGrants[grant]++
	var once sync.Once
	return func() {
		once.Do(func() {
			remoteReadGrantsLock.Lock()
			defer remoteReadGrantsLock.Unlock()
			remoteReadGrants[grant]--
			if remoteReadGrants[grant] <= 0 {
				delete(remoteReadGrants, grant)
			}
		})
	}
}

func remoteReadGranted(conn string, routeId string, path string) bool {
	if conn == "" || path == "" {
		return false
	}
	remoteReadGrantsLock.Lock()
	defer remoteReadGrantsLock.Unlock()
	return remoteReadGrants[remoteReadGrant{conn: NormConnName(conn), route: routeId, path: path}] > 0
}

// remoteReadPath is the file a remotefileinfo or remotefilestream request reads.
func remoteReadPath(command string, data any) string {
	switch command {
	case "remotefileinfo":
		path, _ := data.(string)
		return path
	case "remotefilestream":
		fields, _ := data.(map[string]any)
		path, _ := fields["path"].(string)
		return path
	}
	return ""
}

// remoteRouteRefusal is why a request a remote host sends is refused, "" when it goes through: a host reaches no
// connection server but its own (this computer's conn:local, with its file and process commands, included), no job
// or controller route its own link does not serve, and no link: address but its own. Two exceptions keep Wave's
// copies between connections: stream data and acks, and the read of the very file a copy wavesrv started pulls
// (GrantRemoteRead).
func (router *WshRouter) remoteRouteRefusal(msg RpcMessage, ingressLinkId baseds.LinkId) string {
	routeId := msg.Route
	router.lock.Lock()
	defer router.lock.Unlock()
	conn, remote := router.remoteLinkConn_withlock(ingressLinkId)
	if !remote {
		return ""
	}
	if strings.HasPrefix(routeId, RoutePrefix_Conn) {
		if msg.Command == wshrpc.Command_StreamData || msg.Command == wshrpc.Command_StreamDataAck {
			return ""
		}
		if remoteReadGranted(conn, routeId, remoteReadPath(msg.Command, msg.Data)) {
			return ""
		}
	}
	if strings.HasPrefix(routeId, RoutePrefix_Link) {
		linkId, err := strconv.ParseInt(strings.TrimPrefix(routeId, RoutePrefix_Link), 10, 32)
		if err == nil && baseds.LinkId(linkId) == ingressLinkId {
			return ""
		}
		return fmt.Sprintf("refused: an SSH or WSL host cannot address %q; it reaches only its own link. A server you connect to cannot run programs or open files on this computer.", routeId)
	}
	if !strings.HasPrefix(routeId, RoutePrefix_Conn) && !strings.HasPrefix(routeId, RoutePrefix_Job) && !strings.HasPrefix(routeId, RoutePrefix_Controller) {
		return ""
	}
	if router.routeMap[routeId] == ingressLinkId {
		return ""
	}
	return fmt.Sprintf("refused: an SSH or WSL host cannot send %q to this computer or another connection; it reaches only its own connection. A server you connect to cannot run programs or open files on this computer; do it from the MoltenTerm window or a terminal of this computer.", routeId)
}

// refuseRemoteRoute answers a request remoteRouteRefusal refused, as handleNoRoute answers one with no route.
func (router *WshRouter) refuseRemoteRoute(msg RpcMessage, ingressLinkId baseds.LinkId, reason string) {
	lm := router.getLinkMeta(ingressLinkId)
	if lm == nil || msg.ReqId == "" {
		return
	}
	respBytes, _ := json.Marshal(RpcMessage{ResId: msg.ReqId, Error: reason})
	router.sendRpcMessageToLink(lm.linkId, lm.client, respBytes, baseds.NoLinkId, "remote-refused")
}

func runMoltenRequestGuard(ctx context.Context, command string, data any) (any, error) {
	if MoltenRequestGuard == nil {
		return data, nil
	}
	return MoltenRequestGuard(ctx, command, data)
}
