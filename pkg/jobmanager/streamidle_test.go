// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package jobmanager

import (
	"io"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func dataPackets(tw *testWriter) []wshrpc.CommandStreamData {
	var rtn []wshrpc.CommandStreamData
	for _, pkt := range tw.GetPackets() {
		if pkt.Data64 != "" {
			rtn = append(rtn, pkt)
		}
	}
	return rtn
}

// FR-PERF-011 (#457): the stall check sleeps while the stream is idle, and the first bytes after the idle period
// still get resent when their ACK is lost.
func TestStallCheckWakesAfterIdle(t *testing.T) {
	tw := &testWriter{}
	sm := MakeStreamManager()
	defer sm.Close()
	pr, pw := io.Pipe()
	defer pw.Close()
	if err := sm.AttachReader(pr); err != nil {
		t.Fatal(err)
	}
	if _, err := sm.ClientConnected("s", tw, CwndSize, 0); err != nil {
		t.Fatal(err)
	}
	pw.Write([]byte("a"))
	time.Sleep(50 * time.Millisecond)
	if n := len(dataPackets(tw)); n != 1 {
		t.Fatalf("first write: %d packets", n)
	}
	sm.RecvAck(wshrpc.CommandStreamAckData{Id: "s", Seq: 1, RWnd: CwndSize})
	// Idle past the stall timeout: nothing is resent.
	time.Sleep(StallTimeout + 2*StallCheckEvery)
	if n := len(dataPackets(tw)); n != 1 {
		t.Fatalf("an idle, acknowledged stream resent: %d packets", n)
	}
	pw.Write([]byte("b"))
	// Bytes sent after a long idle period are not taken for stalled since the last ACK.
	time.Sleep(3 * StallCheckEvery)
	if n := len(dataPackets(tw)); n != 2 {
		t.Fatalf("the write after the idle period: %d packets, want 2 (no early resend)", n)
	}
	deadline := time.Now().Add(StallTimeout + 4*StallCheckEvery)
	for time.Now().Before(deadline) {
		if pkts := dataPackets(tw); len(pkts) >= 3 && pkts[2].Seq == 1 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the unacknowledged byte after the idle period was not resent: %+v", dataPackets(tw))
}
