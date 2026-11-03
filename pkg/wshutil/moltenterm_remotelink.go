// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// An SSH or WSL host reaches wavesrv through its connection's link: nothing it runs may start a process or open a
// path on this computer (NFR-FORK-001 (12), #1831). A link is a host's by the way it arrived (a connection's socket
// or stdio) or by the connection its token named, never by what a request says.

const remoteRefusalHint = " A server you connect to cannot run programs or open files on this computer; do it from the MoltenTerm window or a terminal of this computer."

// MoltenRequestGuard, when set (wavesrv sets it at start), runs before every request a WshRpc of this process
// answers: it refuses the request with an error, or returns the data the handler gets (rewritten or as is).
var MoltenRequestGuard func(ctx context.Context, command string, data any) (any, error)

// MoltenJobConn, when set (wavesrv sets it at start), is the connection a job runs on, false when there is no such
// job: a host announces the route of its own connection's jobs only.
var MoltenJobConn func(jobId string) (string, bool)

// HandleStdIOClient serves a router link over stdio whose connection is unknown.
func HandleStdIOClient(logName string, input chan utilfn.LineOutput, output io.Writer) {
	HandleConnStdIOClient(logName, "", input, output)
}

// RunWshRpcOverListener serves this computer's own socket (local terminals).
func RunWshRpcOverListener(listener net.Listener, readCallback func()) {
	RunConnWshRpcOverListener(listener, "", readCallback)
}

func isRemoteConnName(connName string) bool {
	return connName != "" && connName != wshrpc.LocalConnName && !strings.HasPrefix(connName, wshrpc.LocalConnName+":")
}

// registerUntrustedConnLink registers a link that arrived through connName's socket or stdio: it is that
// connection's before it reads its first message.
func (router *WshRouter) registerUntrustedConnLink(client AbstractRpcClient, connName string) baseds.LinkId {
	if !isRemoteConnName(connName) {
		return router.RegisterUntrustedLink(client)
	}
	router.lock.Lock()
	defer router.lock.Unlock()
	router.nextLinkId++
	linkId := router.nextLinkId
	lm := &linkMeta{linkId: linkId, client: client, connName: connName}
	log.Printf("wshrouter register link %s (connection %s)", lm.Name(), connName)
	router.linkMap[linkId] = lm
	go router.runLinkClientRecvLoop(linkId, client)
	return linkId
}

// setLinkConn records the remote connection a link's token named. The way a link arrived wins: a token never
// changes the connection of a link that already has one.
func (router *WshRouter) setLinkConn(linkId baseds.LinkId, connName string) {
	if !isRemoteConnName(connName) {
		return
	}
	router.lock.Lock()
	defer router.lock.Unlock()
	if lm := router.linkMap[linkId]; lm != nil && lm.connName == "" {
		lm.connName = connName
	}
}

// RemoteLinkConn tells whether ingressLinkId is an SSH or WSL host's link: a trusted router link other than the
// windows' websocket, or a link that arrived through a connection or whose token named one. It also returns the
// connection, "" when unknown. Takes the router's lock: never call it from SendRpcMessage.
func (router *WshRouter) RemoteLinkConn(ingressLinkId baseds.LinkId) (string, bool) {
	if ingressLinkId == baseds.NoLinkId {
		return "", false
	}
	router.lock.Lock()
	defer router.lock.Unlock()
	return router.remoteLinkConn_withlock(ingressLinkId)
}

func (router *WshRouter) remoteLinkConn_withlock(linkId baseds.LinkId) (string, bool) {
	return linkRemoteConn(router.linkMap[linkId])
}

func linkRemoteConn(lm *linkMeta) (string, bool) {
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

func sameRemoteConn(a string, b string) bool {
	return isRemoteConnName(a) && NormConnName(a) == NormConnName(b)
}

// checkRemoteAnnounce refuses a route a host's router link may not announce: only free routes of its own scope
// (its connection's conn: route, its processes' proc: routes, its connection's jobs), never wavesrv's, a window's,
// Electron main's or a controller's, and never a route another link holds (but the same connection's earlier link,
// while it reconnects). A host that took conn:local or a local job's route would receive what wavesrv sends there.
// The job's connection is checked first, outside the router's lock (MoltenJobConn).
func (router *WshRouter) checkRemoteAnnounce(linkId baseds.LinkId, routeId string) error {
	conn, remote := router.RemoteLinkConn(linkId)
	if !remote || !strings.HasPrefix(routeId, RoutePrefix_Job) {
		return nil
	}
	jobId := strings.TrimPrefix(routeId, RoutePrefix_Job)
	if MoltenJobConn == nil {
		return nil
	}
	jobConn, ok := MoltenJobConn(jobId)
	if !ok || !sameRemoteConn(conn, jobConn) {
		return fmt.Errorf("refused: an SSH or WSL host cannot take the route %q of a job that is not on its connection", routeId)
	}
	return nil
}

func (router *WshRouter) remoteAnnounceRefusal_withlock(lm *linkMeta, routeId string, isSourceRoute bool) error {
	conn, remote := linkRemoteConn(lm)
	if !remote {
		return nil
	}
	if holder := router.routeMap[routeId]; holder != baseds.NoLinkId && holder != lm.linkId {
		holderConn, holderRemote := linkRemoteConn(router.linkMap[holder])
		if !holderRemote || !sameRemoteConn(conn, holderConn) {
			return fmt.Errorf("refused: an SSH or WSL host cannot take the route %q, which another link holds", routeId)
		}
	}
	if isSourceRoute {
		return nil
	}
	switch {
	case strings.HasPrefix(routeId, RoutePrefix_Conn):
		if sameRemoteConn(conn, strings.TrimPrefix(routeId, RoutePrefix_Conn)) {
			return nil
		}
	case strings.HasPrefix(routeId, RoutePrefix_Proc), strings.HasPrefix(routeId, RoutePrefix_Job):
		return nil
	}
	return fmt.Errorf("refused: an SSH or WSL host cannot announce the route %q; it announces only its own connection, processes and jobs", routeId)
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

// RemoteReadGranted tells whether the host of conn may read path from routeId's server now (GrantRemoteRead).
func RemoteReadGranted(conn string, routeId string, path string) bool {
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

// remoteElectronCommands are what a host may ask Electron main: a notification and the bell.
var remoteElectronCommands = map[string]bool{
	"notify":             true,
	"electronsystembell": true,
}

// remoteRouteRefusal is why a request a remote host sends is refused, "" when it goes through. A host reaches
// wavesrv (whose guard checks each command), the router's control route, wavesrv's own leaves that check their
// callers (the molten routes), the routes and link it serves itself, and Electron main for a notification. Never
// this computer's connection server (conn:local), another connection, a job, a controller, a window's tab or panel
// routes, or a local terminal. Two exceptions keep Wave's copies between connections: stream data and acks, and the
// read of the very file a copy wavesrv started pulls (GrantRemoteRead).
func (router *WshRouter) remoteRouteRefusal(msg RpcMessage, ingressLinkId baseds.LinkId) string {
	routeId := msg.Route
	router.lock.Lock()
	defer router.lock.Unlock()
	conn, remote := router.remoteLinkConn_withlock(ingressLinkId)
	if !remote {
		return ""
	}
	if strings.HasPrefix(routeId, RoutePrefix_Link) {
		linkId, err := strconv.ParseInt(strings.TrimPrefix(routeId, RoutePrefix_Link), 10, 32)
		if err == nil && baseds.LinkId(linkId) == ingressLinkId {
			return ""
		}
		return fmt.Sprintf("refused: an SSH or WSL host cannot address %q; it reaches only its own link."+remoteRefusalHint, routeId)
	}
	if routeId == "" || routeId == DefaultRoute || routeId == ControlRoute {
		return ""
	}
	holder := router.routeMap[routeId]
	if holder == ingressLinkId {
		return ""
	}
	if strings.HasPrefix(routeId, RoutePrefix_Conn) {
		if msg.Command == wshrpc.Command_StreamData || msg.Command == wshrpc.Command_StreamDataAck {
			return ""
		}
		if RemoteReadGranted(conn, routeId, remoteReadPath(msg.Command, msg.Data)) {
			return ""
		}
		return fmt.Sprintf("refused: an SSH or WSL host cannot send %q to %q; it reaches only its own connection."+remoteRefusalHint, msg.Command, routeId)
	}
	if routeId == ElectronRoute {
		if remoteElectronCommands[msg.Command] {
			return ""
		}
		return fmt.Sprintf("refused: an SSH or WSL host cannot ask MoltenTerm's app for %q; it only shows notifications."+remoteRefusalHint, msg.Command)
	}
	if lm := router.linkMap[holder]; lm != nil && lm.inProcess && !strings.HasPrefix(routeId, RoutePrefix_Job) && !strings.HasPrefix(routeId, RoutePrefix_Controller) {
		return ""
	}
	return fmt.Sprintf("refused: an SSH or WSL host cannot send %q to %q, a window, a panel or a process of this computer."+remoteRefusalHint, msg.Command, routeId)
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
