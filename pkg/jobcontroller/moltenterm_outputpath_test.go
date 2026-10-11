// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package jobcontroller

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

type scriptedReader struct {
	ch chan outputChunk
}

func (r *scriptedReader) Read(p []byte) (int, error) {
	chunk, ok := <-r.ch
	if !ok {
		return 0, io.EOF
	}
	n := copy(p, chunk.data)
	return n, chunk.err
}

type flushRecorder struct {
	lock    sync.Mutex
	flushes [][]byte
	times   []time.Time
}

func (f *flushRecorder) flush(data []byte) bool {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.flushes = append(f.flushes, append([]byte(nil), data...))
	f.times = append(f.times, time.Now())
	return true
}

func (f *flushRecorder) snapshot() ([][]byte, []time.Time) {
	f.lock.Lock()
	defer f.lock.Unlock()
	return append([][]byte(nil), f.flushes...), append([]time.Time(nil), f.times...)
}

func runPump(r outputReader, window time.Duration, maxBytes int, rec *flushRecorder) chan error {
	done := make(chan error, 1)
	go func() { done <- pumpOutput(r, window, maxBytes, rec.flush) }()
	return done
}

func TestPumpOutputFlushesAfterQuietAtOnce(t *testing.T) {
	r := &scriptedReader{ch: make(chan outputChunk)}
	rec := &flushRecorder{}
	done := runPump(r, 200*time.Millisecond, 1<<20, rec)
	sent := time.Now()
	r.ch <- outputChunk{data: []byte("echo")}
	deadline := time.Now().Add(time.Second)
	for {
		flushes, times := rec.snapshot()
		if len(flushes) == 1 {
			if string(flushes[0]) != "echo" {
				t.Fatalf("flushed %q, want echo", flushes[0])
			}
			if lat := times[0].Sub(sent); lat > 100*time.Millisecond {
				t.Fatalf("first chunk after a quiet period waited %v, want no coalescing delay", lat)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no flush")
		}
		time.Sleep(time.Millisecond)
	}
	close(r.ch)
	if err := <-done; err != io.EOF {
		t.Fatalf("pump returned %v, want EOF", err)
	}
}

func TestPumpOutputCoalescesABurstInOrder(t *testing.T) {
	r := &scriptedReader{ch: make(chan outputChunk, 1000)}
	rec := &flushRecorder{}
	var want bytes.Buffer
	for i := 0; i < 500; i++ {
		chunk := bytes.Repeat([]byte{byte('a' + i%26)}, 100)
		want.Write(chunk)
		r.ch <- outputChunk{data: chunk}
	}
	close(r.ch)
	err := <-runPump(r, 50*time.Millisecond, 1<<20, rec)
	if err != io.EOF {
		t.Fatalf("pump returned %v, want EOF", err)
	}
	flushes, _ := rec.snapshot()
	if got := bytes.Join(flushes, nil); !bytes.Equal(got, want.Bytes()) {
		t.Fatalf("flushed data differs from the data read (%d vs %d bytes)", len(got), want.Len())
	}
	if len(flushes) > 3 {
		t.Fatalf("500 reads of one burst gave %d flushes, want them coalesced", len(flushes))
	}
}

func TestPumpOutputRespectsMaxBytesAndWindow(t *testing.T) {
	r := &scriptedReader{ch: make(chan outputChunk)}
	rec := &flushRecorder{}
	done := runPump(r, 30*time.Millisecond, 1000, rec)
	r.ch <- outputChunk{data: []byte("x")} // flushed at once (quiet)
	for i := 0; i < 5; i++ {
		r.ch <- outputChunk{data: bytes.Repeat([]byte("y"), 400)}
	}
	time.Sleep(100 * time.Millisecond)
	close(r.ch)
	<-done
	flushes, _ := rec.snapshot()
	total := 0
	for _, f := range flushes {
		if len(f) > 1000+400 {
			t.Fatalf("flush of %d bytes, want at most maxBytes plus one read", len(f))
		}
		total += len(f)
	}
	if total != 2001 {
		t.Fatalf("flushed %d bytes, want 2001", total)
	}
	if len(flushes) < 3 {
		t.Fatalf("got %d flushes, want the first read alone, then chunks capped by maxBytes", len(flushes))
	}
}

func TestPumpOutputFlushesBeforeAReadError(t *testing.T) {
	r := &scriptedReader{ch: make(chan outputChunk, 4)}
	rec := &flushRecorder{}
	boom := errors.New("boom")
	r.ch <- outputChunk{data: []byte("a")}
	r.ch <- outputChunk{data: []byte("b")}
	r.ch <- outputChunk{data: []byte("c"), err: boom}
	err := <-runPump(r, time.Second, 1<<20, rec)
	if err != boom {
		t.Fatalf("pump returned %v, want the read error", err)
	}
	flushes, _ := rec.snapshot()
	if got := string(bytes.Join(flushes, nil)); got != "abc" {
		t.Fatalf("flushed %q, want abc", got)
	}
}

func TestPumpOutputStopsWhenSuperseded(t *testing.T) {
	r := &scriptedReader{ch: make(chan outputChunk)}
	calls := 0
	done := make(chan error, 1)
	go func() {
		done <- pumpOutput(r, 0, 1<<20, func([]byte) bool { calls++; return false })
	}()
	r.ch <- outputChunk{data: []byte("late")}
	select {
	case err := <-done:
		if err != nil || calls != 1 {
			t.Fatalf("pump returned %v after %d flushes, want nil after 1", err, calls)
		}
	case <-time.After(time.Second):
		t.Fatalf("pump did not stop when its flush reported the stream superseded")
	}
}

type eventRecorder struct {
	lock   sync.Mutex
	events map[string][]wps.WaveEvent
}

func (c *eventRecorder) SendEvent(routeId string, event wps.WaveEvent) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.events[routeId] = append(c.events[routeId], event)
}

func (c *eventRecorder) get(routeId string) []wps.WaveEvent {
	c.lock.Lock()
	defer c.lock.Unlock()
	return append([]wps.WaveEvent(nil), c.events[routeId]...)
}

func initOutputPathStores(t *testing.T) {
	dataDir := t.TempDir()
	saved := wavebase.DataHome_VarCache
	wavebase.DataHome_VarCache = dataDir
	t.Cleanup(func() { wavebase.DataHome_VarCache = saved })
	if err := os.MkdirAll(filepath.Join(dataDir, wavebase.WaveDBDir), 0700); err != nil {
		t.Fatal(err)
	}
	if err := wstore.InitWStore(); err != nil {
		t.Fatal(err)
	}
	if err := filestore.InitFilestore(); err != nil {
		t.Fatal(err)
	}
}

func readZoneFile(t *testing.T, zoneId string) string {
	_, data, err := filestore.WFS.ReadFile(context.Background(), zoneId, JobOutputFileName)
	if err != nil {
		t.Fatalf("reading %s/%s: %v", zoneId, JobOutputFileName, err)
	}
	return string(data)
}

// Characterization of a durable shell's output path (FR-PERF-010-AC2): the job file and the attached block's file get
// every byte, the block's renderers get each chunk as one event, the attention scan sees it, and an attach moves the
// output to the new block.
func TestJobOutputPath(t *testing.T) {
	initOutputPathStores(t)
	ctx := context.Background()
	const jobId, blockA, blockB = "job-456", "block-a-456", "block-b-456"
	for _, b := range []string{blockA, blockB} {
		if err := wstore.DBInsert(ctx, &waveobj.Block{OID: b, Meta: waveobj.MetaMapType{}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := wstore.DBInsert(ctx, &waveobj.Job{OID: jobId, AttachedBlockId: blockA}); err != nil {
		t.Fatal(err)
	}
	if err := wstore.DBUpdateFn(ctx, blockA, func(b *waveobj.Block) { b.JobId = jobId }); err != nil {
		t.Fatal(err)
	}
	for _, zone := range []string{jobId, blockA, blockB} {
		if err := filestore.WFS.MakeFile(ctx, zone, JobOutputFileName, wshrpc.FileMeta{}, wshrpc.FileOpts{}); err != nil {
			t.Fatal(err)
		}
	}

	rec := &eventRecorder{events: make(map[string][]wps.WaveEvent)}
	savedClient := wps.Broker.GetClient()
	wps.Broker.SetClient(rec)
	t.Cleanup(func() {
		wps.Broker.SetClient(savedClient)
		wps.Broker.UnsubscribeAll("tab-a")
		wps.Broker.UnsubscribeAll("tab-b")
		wps.Broker.UnsubscribeAll("tab-other")
	})
	wps.Broker.Subscribe("tab-a", wps.SubscriptionRequest{Event: wps.Event_BlockFile, Scopes: []string{"block:" + blockA}})
	wps.Broker.Subscribe("tab-b", wps.SubscriptionRequest{Event: wps.Event_BlockFile, Scopes: []string{"block:" + blockB}})
	wps.Broker.Subscribe("tab-other", wps.SubscriptionRequest{Event: wps.Event_BlockFile, Scopes: []string{"block:unrelated"}})

	var scanLock sync.Mutex
	scanned := map[string]string{}
	attention.OnTerminalOutput(func(blockId string, data []byte) {
		scanLock.Lock()
		defer scanLock.Unlock()
		scanned[blockId] += string(data)
	})

	InvalidateAttachedBlock(jobId)
	loads0 := attachedBlockCache.loads.Load()
	chunks := []string{"hello ", "world\r\n", "\x1b]9;agent done\x07"}
	for _, c := range chunks {
		if err := handleAppendJobFile(ctx, jobId, JobOutputFileName, []byte(c)); err != nil {
			t.Fatal(err)
		}
	}
	all := "hello world\r\n\x1b]9;agent done\x07"
	if got := readZoneFile(t, jobId); got != all {
		t.Fatalf("job file %q, want %q", got, all)
	}
	if got := readZoneFile(t, blockA); got != all {
		t.Fatalf("block file %q, want %q", got, all)
	}
	events := rec.get("tab-a")
	if len(events) != len(chunks) {
		t.Fatalf("tab-a got %d events for %d chunks, want one each", len(events), len(chunks))
	}
	for i, ev := range events {
		data := ev.Data.(*wps.WSFileEventData)
		raw, _ := base64.StdEncoding.DecodeString(data.Data64)
		if len(ev.Scopes) != 1 || ev.Scopes[0] != "block:"+blockA || data.ZoneId != blockA || string(raw) != chunks[i] {
			t.Fatalf("event %d = scopes %v zone %s data %q", i, ev.Scopes, data.ZoneId, raw)
		}
	}
	if n := len(rec.get("tab-b")) + len(rec.get("tab-other")); n != 0 {
		t.Fatalf("renderers that do not show the block got %d events", n)
	}
	if loads := attachedBlockCache.loads.Load() - loads0; loads != 1 {
		t.Fatalf("%d DB reads of the job for %d chunks, want 1", loads, len(chunks))
	}
	scanLock.Lock()
	if scanned[blockA] != all {
		t.Fatalf("attention scan saw %q, want %q", scanned[blockA], all)
	}
	scanLock.Unlock()

	if err := AttachJobToBlock(ctx, jobId, blockB); err == nil {
		t.Fatalf("attaching a job attached elsewhere should fail")
	}
	if err := DetachJobFromBlock(ctx, jobId, true); err != nil {
		t.Fatal(err)
	}
	if err := handleAppendJobFile(ctx, jobId, JobOutputFileName, []byte("detached;")); err != nil {
		t.Fatal(err)
	}
	if got := readZoneFile(t, blockA); got != all {
		t.Fatalf("a detached job still wrote to its old block: %q", got)
	}
	if err := AttachJobToBlock(ctx, jobId, blockB); err != nil {
		t.Fatal(err)
	}
	if err := handleAppendJobFile(ctx, jobId, JobOutputFileName, []byte("moved")); err != nil {
		t.Fatal(err)
	}
	if got := readZoneFile(t, blockB); got != "moved" {
		t.Fatalf("block B file %q, want the output after the attach", got)
	}
	if got := readZoneFile(t, jobId); got != all+"detached;moved" {
		t.Fatalf("job file %q", got)
	}
	if n := len(rec.get("tab-b")); n != 1 {
		t.Fatalf("tab-b got %d events after the attach, want 1", n)
	}
	if n := len(rec.get("tab-a")); n != len(chunks) {
		t.Fatalf("tab-a got %d events, want none after the job left its block", n)
	}

	wps.Broker.UnsubscribeAll("tab-b")
	if err := handleAppendJobFile(ctx, jobId, JobOutputFileName, []byte("!")); err != nil {
		t.Fatal(err)
	}
	if got := readZoneFile(t, blockB); got != "moved!" {
		t.Fatalf("without subscribers the block file must still be written: %q", got)
	}
}

func TestAttachedBlockCacheIgnoresALoadThatRacedAnInvalidation(t *testing.T) {
	c := &attachedBlockCacheType{lock: &sync.Mutex{}, blocks: make(map[string]string)}
	_, ok, version := c.lookup("job")
	if ok {
		t.Fatalf("empty cache hit")
	}
	c.invalidate("job") // an attach commits while the load reads the old value
	c.storeIfCurrent("job", "old-block", version)
	if _, ok, _ := c.lookup("job"); ok {
		t.Fatalf("a load that started before an invalidation stored its stale value")
	}
	_, _, version = c.lookup("job")
	c.storeIfCurrent("job", "new-block", version)
	if blockId, ok, _ := c.lookup("job"); !ok || blockId != "new-block" {
		t.Fatalf("lookup = %q %v, want new-block", blockId, ok)
	}
}
