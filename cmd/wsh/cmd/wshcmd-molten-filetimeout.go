// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import "github.com/wavetermdev/waveterm/pkg/wshrpc"

// remoteFileAskTimeoutMs is how long `wsh file` waits on a server: a file of this computer is asked in the MoltenTerm
// window first, a question that waits up to a minute (#1831), so the command completes after Allow.
const remoteFileAskTimeoutMs = int64(75_000)

// moltenFileTimeout is the timeout of one `wsh file` request: --timeout, raised on a server to cover the window's
// question.
func moltenFileTimeout() int64 {
	return fileTimeoutFor(fileTimeout, RpcContext.Conn)
}

func fileTimeoutFor(timeout int64, conn string) int64 {
	if conn == "" || conn == wshrpc.LocalConnName {
		return timeout
	}
	return max(timeout, remoteFileAskTimeoutMs)
}
