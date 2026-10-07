// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package streamclient

import (
	"encoding/base64"
	"io"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

type recordingAcks struct {
	acks []wshrpc.CommandStreamAckData
}

func (ra *recordingAcks) SendAck(ackPk wshrpc.CommandStreamAckData) {
	ra.acks = append(ra.acks, ackPk)
}

func dataPacket(seq int64, data string, eof bool) wshrpc.CommandStreamData {
	return wshrpc.CommandStreamData{Id: "1", Seq: seq, Data64: base64.StdEncoding.EncodeToString([]byte(data)), Eof: eof}
}

func readAvailable(t *testing.T, r *Reader, n int) string {
	buf := make([]byte, n)
	got, err := r.Read(buf)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	return string(buf[:got])
}

func TestResendOfAlreadyReceivedDataIsAcked(t *testing.T) {
	acks := &recordingAcks{}
	r := NewReader("1", 1024, acks)
	r.RecvData(dataPacket(0, "hello", false))
	before := len(acks.acks)

	r.RecvData(dataPacket(0, "hello", false))
	if len(acks.acks) != before+1 {
		t.Fatalf("a resent packet must be acked again (the first ACK may have been lost), got %d acks", len(acks.acks)-before)
	}
	if last := acks.acks[len(acks.acks)-1]; last.Seq != 5 {
		t.Fatalf("ack seq = %d, want 5", last.Seq)
	}
	if got := readAvailable(t, r, 64); got != "hello" {
		t.Fatalf("duplicate data was delivered twice: %q", got)
	}
}

func TestResendOverlappingReceivedDataKeepsOnlyTheNewBytes(t *testing.T) {
	acks := &recordingAcks{}
	r := NewReader("1", 1024, acks)
	r.RecvData(dataPacket(0, "hello", false))
	r.RecvData(dataPacket(3, "lo world", true))

	if got := readAvailable(t, r, 64); got != "hello world" {
		t.Fatalf("got %q, want %q", got, "hello world")
	}
	if _, err := r.Read(make([]byte, 8)); err != io.EOF {
		t.Fatalf("expected EOF, got %v", err)
	}
}

func TestOverlappedOutOfOrderPacketDoesNotBlockTheOnesAfterIt(t *testing.T) {
	acks := &recordingAcks{}
	r := NewReader("1", 1024, acks)
	r.RecvData(dataPacket(5, "56789", false))
	r.RecvData(dataPacket(10, "abcde", false))
	r.RecvData(dataPacket(0, "0123456", false))

	if got := readAvailable(t, r, 64); got != "0123456789abcde" {
		t.Fatalf("got %q, want %q", got, "0123456789abcde")
	}
}
