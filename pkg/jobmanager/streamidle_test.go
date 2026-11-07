// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package jobmanager

import (
	"io"
	"sync"
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

// testClock is the clock of a stream manager under test (#2022): the stall timeout elapses when the test says so, not
// after seconds of waiting.
type testClock struct {
	lock sync.Mutex
	at   time.Time
}

func (c *testClock) now() time.Time {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.at
}

func (c *testClock) advance(d time.Duration) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.at = c.at.Add(d)
}

// useClock replaces the clock the stall check reads. It is read under the manager's lock, so it is replaced under it.
func useClock(sm *StreamManager, now func() time.Time) {
	sm.lock.Lock()
	defer sm.lock.Unlock()
	sm.now = now
}

// waitDataPackets waits for the n-th data packet. A deadline only bounds a failing run.
func waitDataPackets(t *testing.T, tw *testWriter, n int) []wshrpc.CommandStreamData {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		if pkts := dataPackets(tw); len(pkts) >= n {
			return pkts
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("fewer than %d data packets: %+v", n, dataPackets(tw))
	return nil
}

// FR-PERF-011 (#457): the stall check sleeps while the stream is idle, and the first bytes after the idle period
// still get resent when their ACK is lost. The stall timeout elapses on the test's clock (#2022); the loop's own
// period (StallCheckEvery) is the real one, so the order of a wake, the send and the first check stays the app's.
func TestStallCheckWakesAfterIdle(t *testing.T) {
	t.Parallel()
	clock := &testClock{at: time.Unix(1_800_000_000, 0)}
	tw := &testWriter{}
	sm := MakeStreamManager()
	defer sm.Close()
	useClock(sm, clock.now)
	pr, pw := io.Pipe()
	defer pw.Close()
	if err := sm.AttachReader(pr); err != nil {
		t.Fatal(err)
	}
	if _, err := sm.ClientConnected("s", tw, CwndSize, 0); err != nil {
		t.Fatal(err)
	}
	pw.Write([]byte("a"))
	if n := len(waitDataPackets(t, tw, 1)); n != 1 {
		t.Fatalf("first write: %d packets", n)
	}
	sm.RecvAck(wshrpc.CommandStreamAckData{Id: "s", Seq: 1, RWnd: CwndSize})
	// The loop is still in the period it began before the ACK; one more check finds the stream idle and puts it to
	// sleep. This wait only brings the loop to that state: a loop that has not got there yet makes the test weaker,
	// never wrong.
	time.Sleep(2 * StallCheckEvery)
	// Idle past the stall timeout: nothing is resent.
	clock.advance(StallTimeout + 2*StallCheckEvery)
	if done, busy := sm.checkStall(); done || busy {
		t.Fatalf("an idle, acknowledged stream is in flight: done %v busy %v", done, busy)
	}
	if n := len(dataPackets(tw)); n != 1 {
		t.Fatalf("an idle, acknowledged stream resent: %d packets", n)
	}
	pw.Write([]byte("b"))
	if n := len(waitDataPackets(t, tw, 2)); n != 2 {
		t.Fatalf("the write after the idle period: %d packets, want 2", n)
	}
	// Bytes sent after a long idle period are not taken for stalled since the last ACK. The clock stands still, so a
	// resend in these check periods can only come from the loop checking before the bytes were sent.
	time.Sleep(2 * StallCheckEvery)
	if n := len(dataPackets(tw)); n != 2 {
		t.Fatalf("the write after the idle period: %d packets, want 2 (no early resend)", n)
	}
	clock.advance(StallTimeout)
	if pkts := waitDataPackets(t, tw, 3); pkts[2].Seq != 1 {
		t.Fatalf("the unacknowledged byte after the idle period was not resent from its sequence: %+v", pkts)
	}
}

func TestTheStallTimingsKeepTheirProductionValues(t *testing.T) {
	t.Parallel()
	if StallTimeout != 3*time.Second || StallCheckEvery != 500*time.Millisecond {
		t.Fatalf("stall timeout %v, check every %v", StallTimeout, StallCheckEvery)
	}
}
