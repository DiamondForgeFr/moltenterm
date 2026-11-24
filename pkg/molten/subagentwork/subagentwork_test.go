// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package subagentwork

import (
	"fmt"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2502: the one owner of what a terminal's sub-agents work on.

func sub(id string, started int64, jobs ...molten.BackgroundJob) molten.SubagentWork {
	return molten.SubagentWork{Id: id, Description: "#1 " + id, Kind: "sf-build", Started: started, Waiting: len(jobs) > 0, Jobs: jobs}
}

func TestSetKeepsTheOldestFirstAndCopies(t *testing.T) {
	t.Parallel()
	r := MakeRegistry()
	jobs := []molten.BackgroundJob{{Kind: molten.JobVitest, Since: 5}}
	r.Set("b1", []molten.SubagentWork{sub("late", 300), sub("unknown", 0), sub("early", 100, jobs...), {Description: "no id"}})
	got := r.Get("b1")
	if len(got) != 3 || got[0].Id != "early" || got[1].Id != "late" || got[2].Id != "unknown" {
		t.Fatalf("the oldest first, the one without a start last, the one without an id never: %+v", got)
	}
	if r.Count("b1") != 3 || r.Count("other") != 0 {
		t.Errorf("counts: %d, %d", r.Count("b1"), r.Count("other"))
	}
	jobs[0].Kind = "changed"
	got[0].Jobs[0].Kind = "changed too"
	if again := r.Get("b1"); again[0].Jobs[0].Kind != molten.JobVitest {
		t.Errorf("neither the caller's slice nor a copy it holds reaches the registry: %+v", again[0].Jobs)
	}
}

func TestSetIsCappedPerTerminalAndPerRegistry(t *testing.T) {
	t.Parallel()
	r := MakeRegistry()
	var many []molten.SubagentWork
	for i := 0; i < molten.MaxSubagentWork+5; i++ {
		many = append(many, sub(fmt.Sprintf("a%02d", i), int64(i+1)))
	}
	r.Set("b1", many)
	if r.Count("b1") != molten.MaxSubagentWork {
		t.Errorf("a terminal carries at most %d: %d", molten.MaxSubagentWork, r.Count("b1"))
	}
	for i := 0; i < maxBlocks+10; i++ {
		r.Set(fmt.Sprintf("block-%d", i), []molten.SubagentWork{sub("a", 1)})
	}
	if got := len(r.byBlock); got > maxBlocks {
		t.Errorf("at most %d terminals: %d", maxBlocks, got)
	}
	r.Set("b1", nil)
	r.Set("block-0", []molten.SubagentWork{sub("a", 2)})
	if r.Count("block-0") != 1 {
		t.Errorf("a terminal that had work keeps updating when the registry is full")
	}
}

func TestOnChangeComesOnlyForAChangeAndWithNoLockHeld(t *testing.T) {
	t.Parallel()
	r := MakeRegistry()
	var told []string
	r.OnChange(func(blockId string) {
		// The handler reads and writes the registry: a lock held while it runs would deadlock here.
		told = append(told, fmt.Sprintf("%s:%d", blockId, r.Count(blockId)))
		r.Revision(blockId)
	})
	work := []molten.SubagentWork{sub("a", 1, molten.BackgroundJob{Kind: molten.JobGoTest, Since: 9})}
	r.Set("b1", work)
	r.Set("b1", work)
	r.Set("b1", []molten.SubagentWork{sub("a", 1, molten.BackgroundJob{Kind: molten.JobGoTest, Since: 9})})
	r.Set("b2", nil)
	if len(told) != 1 || told[0] != "b1:1" {
		t.Fatalf("told once, for the change: %v", told)
	}
	r.Set("b1", []molten.SubagentWork{sub("a", 1)})
	r.Forget("b1")
	r.Forget("b1")
	if len(told) != 3 || told[2] != "b1:0" {
		t.Fatalf("a change of jobs and the end of the work are told too: %v", told)
	}
}

func TestDiscardIsSilent(t *testing.T) {
	t.Parallel()
	r := MakeRegistry()
	told := 0
	r.OnChange(func(string) { told++ })
	r.Set("b1", []molten.SubagentWork{sub("a", 1)})
	r.Discard("b1")
	if r.Count("b1") != 0 || r.Revision("b1") != 0 {
		t.Errorf("discarded: %d, revision %d", r.Count("b1"), r.Revision("b1"))
	}
	if told != 1 {
		t.Errorf("only the Set was told: %d", told)
	}
}

func TestRevisionMovesWithEveryChange(t *testing.T) {
	t.Parallel()
	r := MakeRegistry()
	if r.Revision("b1") != 0 {
		t.Fatalf("none yet")
	}
	r.Set("b1", []molten.SubagentWork{sub("a", 1)})
	first := r.Revision("b1")
	r.Set("b2", []molten.SubagentWork{sub("a", 1)})
	r.Set("b1", []molten.SubagentWork{sub("a", 1)})
	if r.Revision("b1") != first {
		t.Errorf("the same work is no change")
	}
	r.Set("b1", []molten.SubagentWork{sub("a", 1), sub("b", 2)})
	if r.Revision("b1") <= first || r.Revision("b1") == r.Revision("b2") {
		t.Errorf("a change takes a number of its own: %d after %d, other terminal %d", r.Revision("b1"), first, r.Revision("b2"))
	}
}

// Readers on one goroutine and a writer on another never hold the registry's lock while calling out, so neither
// can wait for the other for ever (the cycle of #2502: the agent states hold a lock while they read, the companion
// holds another while it writes).
func TestReadersAndWritersDoNotWaitForEachOther(t *testing.T) {
	t.Parallel()
	r := MakeRegistry()
	var wg sync.WaitGroup
	var mine sync.Mutex
	r.OnChange(func(string) {
		mine.Lock()
		defer mine.Unlock()
	})
	for i := 0; i < 4; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for n := 0; n < 200; n++ {
				mine.Lock()
				r.Get("b1")
				r.Count("b1")
				mine.Unlock()
			}
		}()
		go func(i int) {
			defer wg.Done()
			for n := 0; n < 200; n++ {
				r.Set("b1", []molten.SubagentWork{sub(fmt.Sprintf("a%d", (n+i)%3), int64(n+1))})
			}
		}(i)
	}
	wg.Wait()
}
