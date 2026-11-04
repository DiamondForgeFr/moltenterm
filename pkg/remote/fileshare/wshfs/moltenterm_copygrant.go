// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshfs

import (
	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// moltenGrantCopySource lets the destination's server read the source file while a copy between two connections
// runs: an SSH or WSL host reads no other connection's file otherwise (NFR-FORK-001 (12), #1831). The path is the
// one the destination parses back from the source uri.
func moltenGrantCopySource(srcConn *connparse.Connection, destConn *connparse.Connection) (revoke func()) {
	if srcConn.Host == destConn.Host {
		return func() {}
	}
	path := srcConn.Path
	if parsed, err := connparse.ParseURI(srcConn.GetFullURI()); err == nil {
		path = parsed.Path
	}
	return wshutil.GrantRemoteRead(destConn.Host, srcConn.Host, path)
}
