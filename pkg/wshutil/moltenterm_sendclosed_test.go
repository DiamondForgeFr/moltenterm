// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wshutil

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// #1208: a request sent while the link ends finds its output channel closed before the server reads as done. It fails
// with an error; it was recovered into a nil handler that SendRpcRequest then dereferenced, crashing wsh.
func TestSendOnAClosedOutputFails(t *testing.T) {
	outputCh := make(chan []byte)
	rpc := MakeWshRpcWithChannels(nil, outputCh, wshrpc.RpcContext{}, nil, "test")
	close(outputCh)
	if rpc.IsServerDone() {
		t.Skip("the server already reads as done: the race this guards is not set up")
	}
	if _, err := rpc.SendRpcRequest("test", nil, &wshrpc.RpcOpts{Timeout: 60_000}); err == nil {
		t.Fatal("a send on a closed output succeeded")
	}
	if handler, err := rpc.SendComplexRequest("test", nil, &wshrpc.RpcOpts{Timeout: 60_000}); handler != nil || err == nil {
		t.Fatalf("handler %v, err %v", handler, err)
	}
}
