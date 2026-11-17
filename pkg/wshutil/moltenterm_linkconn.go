// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import (
	"log"
	"net"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// ServeRpcLinkConn serves a stream connection as an untrusted link of the router (#2334, #2340). The link is
// registered before the reader starts, so a connection that closes at once is still unregistered, and when the
// connection ends the link is unregistered before its proxy is closed: the router never keeps a closed link, and the
// writer goroutine ends with the proxy instead of waiting forever on its channel.
func ServeRpcLinkConn(router *WshRouter, conn net.Conn, peerInfo string, connName string, readCallback func()) baseds.LinkId {
	proxy := MakeRpcProxy(peerInfo)
	linkId := router.registerUntrustedConnLink(proxy, connName)
	go func() {
		defer func() {
			panichandler.PanicHandler("ServeRpcLinkConn:AdaptOutputChToStream", recover())
		}()
		writeErr := AdaptOutputChToStream(proxy.ToRemoteCh, conn)
		if writeErr != nil {
			log.Printf("error writing to %s: %v\n", peerInfo, writeErr)
		}
	}()
	go func() {
		defer func() {
			panichandler.PanicHandler("ServeRpcLinkConn:AdaptStreamToMsgCh", recover())
		}()
		defer func() {
			router.UnregisterLink(linkId)
			conn.Close()
			close(proxy.FromRemoteCh)
			proxy.Close()
		}()
		AdaptStreamToMsgCh(conn, proxy.FromRemoteCh, readCallback)
	}()
	return linkId
}
