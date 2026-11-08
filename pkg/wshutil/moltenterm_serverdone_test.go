// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import (
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// #1926: a request waiting for its answer when the link's input ends gets an error. Its timeout was delivered by the
// server loop, which had ended: the caller waited forever, past any timeout.
func TestPendingRequestFailsWhenTheLinkEnds(t *testing.T) {
	inputCh := make(chan baseds.RpcInputChType, DefaultInputChSize)
	outputCh := make(chan []byte, DefaultOutputChSize)
	rpc := MakeWshRpcWithChannels(inputCh, outputCh, wshrpc.RpcContext{}, nil, "test")
	handler, err := rpc.SendComplexRequest("test", nil, &wshrpc.RpcOpts{Timeout: int64(time.Hour / time.Millisecond)})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	<-outputCh
	close(inputCh)
	answer := make(chan error, 1)
	go func() {
		_, err := handler.NextResponse()
		answer <- err
	}()
	select {
	case err := <-answer:
		if err == nil || !strings.Contains(err.Error(), ErrLinkEnded) {
			t.Fatalf("answer error %v, want %q", err, ErrLinkEnded)
		}
	case <-time.After(time.Minute):
		t.Fatal("the request still waits after its link ended")
	}
}

// A request sent after the link ended fails at once instead of waiting.
func TestRequestAfterTheLinkEndedFails(t *testing.T) {
	inputCh := make(chan baseds.RpcInputChType, DefaultInputChSize)
	rpc := MakeWshRpcWithChannels(inputCh, nil, wshrpc.RpcContext{}, nil, "test")
	close(inputCh)
	deadline := time.Now().Add(time.Minute)
	for !rpc.IsServerDone() {
		if time.Now().After(deadline) {
			t.Fatal("the server loop did not end")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := rpc.SendRpcRequest("test", nil, &wshrpc.RpcOpts{Timeout: int64(time.Hour / time.Millisecond)}); err == nil {
		t.Fatal("a request on an ended link succeeded")
	}
}
