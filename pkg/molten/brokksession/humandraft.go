// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"sync"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// draftRecorder keeps, in his terminal's metadata, whether a human's text waits in his prompt (#2257): true when the
// input watch sees one come in, false only when it sees the prompt emptied. The writes of one terminal run one after
// the other, the latest value last, so "typed, emptied, typed" never ends as "no human" because two writes raced.
type draftRecorder struct {
	write func(blockId string, foreign bool)

	lock    sync.Mutex
	latest  map[string]bool
	running map[string]bool
}

func makeDraftRecorder(write func(blockId string, foreign bool)) *draftRecorder {
	return &draftRecorder{write: write, latest: map[string]bool{}, running: map[string]bool{}}
}

// record queues the value; one writer per terminal writes the latest one until none is left.
func (r *draftRecorder) record(blockId string, foreign bool) {
	if r.queue(blockId, foreign) {
		go r.drain(blockId)
	}
}

func (r *draftRecorder) queue(blockId string, foreign bool) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.latest[blockId] = foreign
	if r.running[blockId] {
		return false
	}
	r.running[blockId] = true
	return true
}

func (r *draftRecorder) next(blockId string) (bool, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	value, ok := r.latest[blockId]
	if !ok {
		delete(r.running, blockId)
		return false, false
	}
	delete(r.latest, blockId)
	return value, true
}

// stopped lets a later value start a new writer after one failed.
func (r *draftRecorder) stopped(blockId string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.running, blockId)
}

func (r *draftRecorder) drain(blockId string) {
	defer func() {
		if panichandler.PanicHandler("molten:brokksession:humandraft", recover()) != nil {
			r.stopped(blockId)
		}
	}()
	for {
		value, ok := r.next(blockId)
		if !ok {
			return
		}
		r.write(blockId, value)
	}
}
