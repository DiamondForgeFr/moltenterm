// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package jobmanager

import (
	"fmt"
	"io"
	"math/rand"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/streamclient"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// lossyLink stands in for the router between the job manager and wavesrv: it delays every message and, when
// reorder is set, lets messages overtake each other.
type lossyLink struct {
	reorder  bool
	dropRate float64
	maxDelay time.Duration
	rnd      *rand.Rand
	lock     sync.Mutex
	deliver  func(item any)
	queue    chan any
}

func makeLossyLink(seed int64, reorder bool, maxDelay time.Duration, deliver func(item any)) *lossyLink {
	l := &lossyLink{reorder: reorder, maxDelay: maxDelay, rnd: rand.New(rand.NewSource(seed)), deliver: deliver, queue: make(chan any, 1<<16)}
	if !reorder {
		go func() {
			for item := range l.queue {
				if d := l.delay(); d > 0 {
					time.Sleep(d)
				}
				l.deliver(item)
			}
		}()
	}
	return l
}

func (l *lossyLink) delay() time.Duration {
	l.lock.Lock()
	defer l.lock.Unlock()
	if l.maxDelay <= 0 {
		return 0
	}
	return time.Duration(l.rnd.Int63n(int64(l.maxDelay)))
}

func (l *lossyLink) dropped() bool {
	l.lock.Lock()
	defer l.lock.Unlock()
	return l.dropRate > 0 && l.rnd.Float64() < l.dropRate
}

func (l *lossyLink) send(item any) {
	if l.dropped() {
		return
	}
	if !l.reorder {
		l.queue <- item
		return
	}
	d := l.delay()
	go func() {
		time.Sleep(d)
		l.deliver(item)
	}()
}

type linkRpc struct {
	dataLink *lossyLink
	ackLink  *lossyLink
}

func (r *linkRpc) StreamDataCommand(data wshrpc.CommandStreamData, opts *wshrpc.RpcOpts) error {
	r.dataLink.send(data)
	return nil
}

func (r *linkRpc) StreamDataAckCommand(data wshrpc.CommandStreamAckData, opts *wshrpc.RpcOpts) error {
	r.ackLink.send(data)
	return nil
}

func frameByte(i int64) byte {
	return byte('a' + (i*7+i/131)%26)
}

type stallRun struct {
	seed       int64
	reorder    bool
	totalBytes int64
	frameBytes int
	hideEvery  int
	hideFor    time.Duration
	linkDelay  time.Duration
	dropRate   float64
	deadline   time.Duration
}

// runStallScenario streams totalBytes from a fake PTY (continuous frames) through a StreamManager and a stream
// reader over a delaying link while the consumer goes away for stretches (a hidden view), and reports whether the
// consumer saw every byte in order before the deadline.
func runStallScenario(cfg stallRun) error {
	rnd := rand.New(rand.NewSource(cfg.seed))
	var writerBroker, readerBroker *streamclient.Broker
	dataLink := makeLossyLink(cfg.seed+1, cfg.reorder, cfg.linkDelay, func(item any) { readerBroker.RecvData(item.(wshrpc.CommandStreamData)) })
	ackLink := makeLossyLink(cfg.seed+2, cfg.reorder, cfg.linkDelay, func(item any) { writerBroker.RecvAck(item.(wshrpc.CommandStreamAckData)) })
	dataLink.dropRate, ackLink.dropRate = cfg.dropRate, cfg.dropRate
	writerBroker = streamclient.NewBroker(&linkRpc{dataLink: dataLink, ackLink: ackLink})
	readerBroker = streamclient.NewBroker(&linkRpc{dataLink: dataLink, ackLink: ackLink})

	reader, meta := readerBroker.CreateStreamReader("reader", "writer", CwndSize)
	sm := MakeStreamManager()
	defer sm.Close()
	if err := writerBroker.AttachStreamWriter(meta, sm); err != nil {
		return err
	}
	if _, err := sm.ClientConnected(meta.Id, writerBroker, int(meta.RWnd), 0); err != nil {
		return err
	}

	pr, pw := io.Pipe()
	defer pr.Close()
	if err := sm.AttachReader(pr); err != nil {
		return err
	}
	go func() {
		defer pw.Close()
		frame := make([]byte, cfg.frameBytes)
		var pos int64
		for pos < cfg.totalBytes {
			n := int64(cfg.frameBytes)
			if cfg.totalBytes-pos < n {
				n = cfg.totalBytes - pos
			}
			for i := int64(0); i < n; i++ {
				frame[i] = frameByte(pos + i)
			}
			if _, err := pw.Write(frame[:n]); err != nil {
				return
			}
			pos += n
			time.Sleep(time.Duration(rnd.Intn(3)) * time.Millisecond)
		}
	}()

	result := make(chan error, 1)
	var progress int64
	var progressLock sync.Mutex
	go func() {
		buf := make([]byte, 4096)
		var pos int64
		reads := 0
		for pos < cfg.totalBytes {
			n, err := reader.Read(buf)
			for i := 0; i < n; i++ {
				if buf[i] != frameByte(pos+int64(i)) {
					result <- fmt.Errorf("corrupt stream at %d", pos+int64(i))
					return
				}
			}
			pos += int64(n)
			progressLock.Lock()
			progress = pos
			progressLock.Unlock()
			if err != nil {
				result <- fmt.Errorf("read error at %d: %w", pos, err)
				return
			}
			reads++
			if cfg.hideEvery > 0 && reads%cfg.hideEvery == 0 {
				time.Sleep(cfg.hideFor)
			}
		}
		result <- nil
	}()

	select {
	case err := <-result:
		return err
	case <-time.After(cfg.deadline):
		progressLock.Lock()
		defer progressLock.Unlock()
		return fmt.Errorf("stalled: consumer got %d of %d bytes, %s", progress, cfg.totalBytes, smState(sm))
	}
}

func smState(sm *StreamManager) string {
	sm.lock.Lock()
	defer sm.lock.Unlock()
	return fmt.Sprintf("sentNotAcked=%d rwnd=%d bufsize=%d maxAckedSeq=%d maxAckedRwnd=%d", sm.sentNotAcked, sm.rwndSize, sm.buf.Size(), sm.maxAckedSeq, sm.maxAckedRwnd)
}

func TestStreamNeverStallsWhileConsumerAway(t *testing.T) {
	runs := 40
	if testing.Short() {
		runs = 5
	}
	for i := 0; i < runs; i++ {
		cfg := stallRun{
			seed:       int64(i) + 1,
			reorder:    i%2 == 1,
			totalBytes: 600 * 1024,
			frameBytes: 11 * 1024,
			hideEvery:  3 + i%7,
			hideFor:    time.Duration(5+i%40) * time.Millisecond,
			linkDelay:  time.Duration(i%4) * time.Millisecond,
			deadline:   20 * time.Second,
		}
		if err := runStallScenario(cfg); err != nil {
			t.Fatalf("run %d (seed %d, reorder %v): %v", i, cfg.seed, cfg.reorder, err)
		}
	}
}

// MOLTENTERM-PATCH (#308): a dropped packet or ACK used to wedge the stream for good (the consumer never saw
// another byte, the program blocked on its PTY write). The stream now resends after StallTimeout.
func TestStreamRecoversFromDroppedMessages(t *testing.T) {
	runs := 4
	if testing.Short() {
		runs = 1
	}
	for i := 0; i < runs; i++ {
		cfg := stallRun{
			seed:       int64(i) + 100,
			reorder:    i%2 == 1,
			totalBytes: 96 * 1024,
			frameBytes: 11 * 1024,
			hideEvery:  4,
			hideFor:    10 * time.Millisecond,
			linkDelay:  time.Millisecond,
			dropRate:   0.02,
			deadline:   60 * time.Second,
		}
		if err := runStallScenario(cfg); err != nil {
			t.Fatalf("run %d (seed %d, reorder %v): %v", i, cfg.seed, cfg.reorder, err)
		}
	}
}
