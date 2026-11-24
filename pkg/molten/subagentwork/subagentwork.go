// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package subagentwork is the one owner of the fact "which sub-agents of an agent terminal work, and on what" (#2502).
// The companion reads it from the sub-agents' own files and writes it here; the agent states read it to count a lead's
// sub-agents after its turn ended (when their hooks went silent), and publish it with the lead's state.
//
// It is a leaf on purpose. The companion calls the agent states (the run of a block) and the agent states cannot call
// the companion (it imports them, and each holds a lock while it works): a record both read from here, under a lock of
// its own that is held for a map access and never while calling out, leaves no cycle between the two.
package subagentwork

import (
	"reflect"
	"sort"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// maxBlocks bounds the terminals that carry work: a terminal's entry goes with its agent run (Forget) or when it
// empties.
const maxBlocks = 256

type Registry struct {
	lock    sync.Mutex
	byBlock map[string][]molten.SubagentWork
	// revs: the revision each terminal's work was last changed at, from one counter, so a window's view tells a change
	// from none by comparing numbers.
	revs     map[string]int64
	rev      int64
	onChange func(blockId string)
}

func MakeRegistry() *Registry {
	return &Registry{byBlock: map[string][]molten.SubagentWork{}, revs: map[string]int64{}}
}

// Default is wavesrv's registry.
var Default = MakeRegistry()

// OnChange sets what is told, with no lock held, when a terminal's work changed.
func (r *Registry) OnChange(fn func(blockId string)) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.onChange = fn
}

// Set replaces a terminal's work and tells OnChange when it differs from what was held. An empty work clears the
// terminal.
func (r *Registry) Set(blockId string, work []molten.SubagentWork) {
	if blockId == "" {
		return
	}
	next := normalize(work)
	notify := r.store(blockId, next)
	if notify != nil {
		notify(blockId)
	}
}

func (r *Registry) store(blockId string, next []molten.SubagentWork) func(string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	current := r.byBlock[blockId]
	if len(current) == 0 && len(next) == 0 {
		return nil
	}
	if reflect.DeepEqual(current, next) {
		return nil
	}
	if len(next) == 0 {
		delete(r.byBlock, blockId)
		r.touchLocked(blockId)
		return r.onChange
	}
	if _, held := r.byBlock[blockId]; !held && len(r.byBlock) >= maxBlocks {
		return nil
	}
	r.byBlock[blockId] = next
	r.touchLocked(blockId)
	return r.onChange
}

func (r *Registry) touchLocked(blockId string) {
	r.rev++
	r.revs[blockId] = r.rev
}

// Forget drops a terminal's work (its agent run ended, its terminal closed) and tells OnChange.
func (r *Registry) Forget(blockId string) {
	r.Set(blockId, nil)
}

// Discard drops a terminal's work without telling anyone: for a reader that holds a lock OnChange would take.
func (r *Registry) Discard(blockId string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.byBlock, blockId)
	delete(r.revs, blockId)
}

// Revision numbers the last change of a terminal's work, 0 for a terminal that never had any.
func (r *Registry) Revision(blockId string) int64 {
	r.lock.Lock()
	defer r.lock.Unlock()
	return r.revs[blockId]
}

// Get is a copy of a terminal's work, the oldest sub-agent first.
func (r *Registry) Get(blockId string) []molten.SubagentWork {
	r.lock.Lock()
	defer r.lock.Unlock()
	held := r.byBlock[blockId]
	if len(held) == 0 {
		return nil
	}
	return copyWork(held)
}

// Count is how many sub-agents a terminal's agent has at work.
func (r *Registry) Count(blockId string) int {
	r.lock.Lock()
	defer r.lock.Unlock()
	return len(r.byBlock[blockId])
}

// normalize copies the work in a stable order (oldest first, then by id), cut to molten.MaxSubagentWork, without a
// sub-agent that has no id (it cannot be told from another).
func normalize(work []molten.SubagentWork) []molten.SubagentWork {
	rtn := make([]molten.SubagentWork, 0, len(work))
	for _, w := range work {
		if w.Id == "" {
			continue
		}
		rtn = append(rtn, copyOne(w))
	}
	sort.SliceStable(rtn, func(i, j int) bool {
		a, b := rtn[i], rtn[j]
		if a.Started != b.Started {
			return a.Started != 0 && (b.Started == 0 || a.Started < b.Started)
		}
		return a.Id < b.Id
	})
	if len(rtn) > molten.MaxSubagentWork {
		rtn = rtn[:molten.MaxSubagentWork]
	}
	return rtn
}

func copyWork(work []molten.SubagentWork) []molten.SubagentWork {
	rtn := make([]molten.SubagentWork, len(work))
	for i, w := range work {
		rtn[i] = copyOne(w)
	}
	return rtn
}

func copyOne(w molten.SubagentWork) molten.SubagentWork {
	if len(w.Jobs) > 0 {
		w.Jobs = append([]molten.BackgroundJob(nil), w.Jobs...)
	} else {
		w.Jobs = nil
	}
	return w
}

func OnChange(fn func(blockId string))               { Default.OnChange(fn) }
func Set(blockId string, work []molten.SubagentWork) { Default.Set(blockId, work) }
func Forget(blockId string)                          { Default.Forget(blockId) }
func Discard(blockId string)                         { Default.Discard(blockId) }
func Get(blockId string) []molten.SubagentWork       { return Default.Get(blockId) }
func Count(blockId string) int                       { return Default.Count(blockId) }
func Revision(blockId string) int64                  { return Default.Revision(blockId) }
