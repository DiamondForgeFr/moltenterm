// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"net"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const moltenResolveTimeout = 3 * time.Second

// moltenResolveHost is net.DefaultResolver's lookup; tests replace it.
var moltenResolveHost = func(ctx context.Context, host string) ([]net.IPAddr, error) {
	return net.DefaultResolver.LookupIPAddr(ctx, host)
}

// moltenHopHosts are the hosts a connection name dials: its own host, and the HostName connections.json or the SSH
// configuration gives it (an alias of localhost included).
func moltenHopHosts(conn string) []string {
	host := metaguard.ConnHost(conn)
	hosts := []string{host}
	norm := wshutil.NormConnName(conn)
	for name, keywords := range wconfig.GetWatcher().GetFullConfig().Connections {
		if wshutil.NormConnName(name) == norm && keywords.SshHostName != nil && *keywords.SshHostName != "" {
			hosts = append(hosts, *keywords.SshHostName)
		}
	}
	if hostName, err := remote.WaveSshConfigUserSettings().GetStrict(host, "HostName"); err == nil && hostName != "" {
		hosts = append(hosts, hostName)
	}
	return hosts
}

// moltenHopHostsFn is moltenHopHosts; tests replace it.
var moltenHopHostsFn = moltenHopHosts

// moltenIsLoopbackTarget tells whether connecting to conn would reach this computer: a loopback name or address, in
// any numeric form, or a name that resolves to one. A name that does not resolve now is left to the dial's check.
func moltenIsLoopbackTarget(ctx context.Context, conn string) bool {
	for _, host := range moltenHopHostsFn(conn) {
		if metaguard.IsLoopbackHost(host) {
			return true
		}
		if net.ParseIP(host) != nil {
			continue
		}
		lookupCtx, cancel := context.WithTimeout(ctx, moltenResolveTimeout)
		addrs, err := moltenResolveHost(lookupCtx, host)
		cancel()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if addr.IP.IsLoopback() || addr.IP.IsUnspecified() {
				return true
			}
		}
	}
	return false
}

func moltenMarkServerRequested(conn string) {
	remote.MarkServerRequested(conn)
}
