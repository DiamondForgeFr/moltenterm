// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package jobcontroller

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Terminal output fan-out (FR-PERF-010, DS-PERF-009, #456). A durable shell's output used to cost, per 4 KB read, two
// file appends, two base64-encoded blockfile events (the job's scope, which nothing reads, and the block's) and a DB
// read of the job to find its block. Now: output read during one frame is merged into one chunk, the job file is
// appended without an event, the attached block comes from an in-memory cache, and the block's event is built only
// when a renderer subscribes to that block.

const (
	OutputCoalesceWindow   = 16 * time.Millisecond
	OutputCoalesceMaxBytes = 128 * 1024
	outputReadBufSize      = 32 * 1024
	outputChunkQueueSize   = 16
)

type attachedBlockCacheType struct {
	lock    *sync.Mutex
	blocks  map[string]string // jobId -> attached block id ("" when the job has none)
	version uint64            // bumped by every invalidation, so a load that raced one does not store a stale value
	loads   atomic.Int64      // DB reads, for tests
}

var attachedBlockCache = &attachedBlockCacheType{
	lock:   &sync.Mutex{},
	blocks: make(map[string]string),
}

func (c *attachedBlockCacheType) lookup(jobId string) (string, bool, uint64) {
	c.lock.Lock()
	defer c.lock.Unlock()
	blockId, ok := c.blocks[jobId]
	return blockId, ok, c.version
}

func (c *attachedBlockCacheType) storeIfCurrent(jobId string, blockId string, version uint64) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if c.version != version {
		return
	}
	c.blocks[jobId] = blockId
}

func (c *attachedBlockCacheType) invalidate(jobIds ...string) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.version++
	for _, jobId := range jobIds {
		delete(c.blocks, jobId)
	}
}

// InvalidateAttachedBlock must follow every change of a job's AttachedBlockId (attach, detach, delete).
func InvalidateAttachedBlock(jobIds ...string) {
	attachedBlockCache.invalidate(jobIds...)
}

func getAttachedBlockId(ctx context.Context, jobId string) (string, error) {
	blockId, ok, version := attachedBlockCache.lookup(jobId)
	if ok {
		return blockId, nil
	}
	attachedBlockCache.loads.Add(1)
	job, err := wstore.DBGet[*waveobj.Job](ctx, jobId)
	if err != nil {
		return "", err
	}
	if job != nil {
		blockId = job.AttachedBlockId
	}
	attachedBlockCache.storeIfCurrent(jobId, blockId, version)
	return blockId, nil
}

// appendJobOutput writes one (coalesced) chunk of a job's output: to the job file, which only the store reads
// (sessions, replay), then to the attached block's file with a single event.
func appendJobOutput(ctx context.Context, jobId string, fileName string, data []byte) error {
	err := filestore.WFS.AppendData(ctx, jobId, fileName, data)
	if err != nil {
		return fmt.Errorf("error appending to job file: %w", err)
	}
	blockId, err := getAttachedBlockId(ctx, jobId)
	if err != nil {
		return fmt.Errorf("error getting job: %w", err)
	}
	if blockId == "" {
		return nil
	}
	err = doWFSAppend(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), fileName, data)
	if err != nil {
		return fmt.Errorf("error appending to block file: %w", err)
	}
	// durable shells raise agents' notifications too (#46, #72)
	if fileName == JobOutputFileName {
		attention.ScanTerminalOutput(blockId, data)
	}
	return nil
}

func hasBlockFileSubscribers(oref waveobj.ORef) bool {
	return wps.Broker.HasSubscribers(wps.Event_BlockFile, oref.String())
}

type outputChunk struct {
	data []byte
	err  error
}

type outputReader interface {
	Read(p []byte) (int, error)
}

// pumpOutput reads r until it fails and hands the data to flush in coalesced chunks. Data that arrives after a quiet
// period is flushed at once (a keystroke's echo keeps its latency); during a burst, reads are merged until window has
// passed since the previous flush or maxBytes are pending. Returns the read error (io.EOF included) after flushing
// what was read before it, or nil when flush returns false (the stream was superseded).
func pumpOutput(r outputReader, window time.Duration, maxBytes int, flush func([]byte) bool) error {
	chunks := make(chan outputChunk, outputChunkQueueSize)
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer func() {
			panichandler.PanicHandler("jobcontroller:pumpOutput:read", recover())
		}()
		buf := make([]byte, outputReadBufSize)
		for {
			n, err := r.Read(buf)
			var chunk outputChunk
			if n > 0 {
				chunk.data = append([]byte(nil), buf[:n]...)
			}
			chunk.err = err
			if chunk.data == nil && err == nil {
				continue
			}
			select {
			case chunks <- chunk:
			case <-done:
				return
			}
			if err != nil {
				return
			}
		}
	}()

	var pending []byte
	var lastFlush time.Time
	var timer *time.Timer
	var timerC <-chan time.Time
	stopTimer := func() {
		if timer != nil {
			timer.Stop()
		}
		timer = nil
		timerC = nil
	}
	doFlush := func() bool {
		stopTimer()
		if len(pending) == 0 {
			return true
		}
		data := pending
		pending = nil
		lastFlush = time.Now()
		return flush(data)
	}
	for {
		var chunk outputChunk
		if len(pending) == 0 {
			chunk = <-chunks
		} else {
			select {
			case chunk = <-chunks:
			case <-timerC:
				if !doFlush() {
					return nil
				}
				continue
			}
		}
		pending = append(pending, chunk.data...)
		if chunk.err != nil {
			if !doFlush() {
				return nil
			}
			return chunk.err
		}
		if len(pending) >= maxBytes {
			if !doFlush() {
				return nil
			}
			continue
		}
		if timerC != nil {
			continue
		}
		wait := window - time.Since(lastFlush)
		if wait > 0 {
			timer = time.NewTimer(wait)
			timerC = timer.C
			continue
		}
		// quiet before this read: take what is already queued, then flush without waiting
		var queuedErr error
	drain:
		for len(pending) < maxBytes {
			select {
			case next := <-chunks:
				pending = append(pending, next.data...)
				if next.err != nil {
					queuedErr = next.err
					break drain
				}
			default:
				break drain
			}
		}
		if !doFlush() {
			return nil
		}
		if queuedErr != nil {
			return queuedErr
		}
	}
}
