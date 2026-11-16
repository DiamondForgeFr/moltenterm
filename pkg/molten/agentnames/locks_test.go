// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentnames

import (
	"fmt"
	"sync"
	"testing"
)

const (
	projectA = "/projects/alpha"
	projectB = "/projects/beta"
)

func lockOf(a *Allocator, name string, project string) LockResult {
	return a.Lock(name, project, false)
}

func TestLockReservesAName(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	res := lockOf(a, "alice", projectA)
	if res.Status != LockDone || res.Name != "Alice" {
		t.Fatalf("lock: %+v", res)
	}
	if got := a.LockedFor("ALICE"); got != projectA {
		t.Fatalf("locked for %q", got)
	}
	if res := lockOf(a, "Alice", projectA); res.Status != LockAlready {
		t.Fatalf("second lock for the same project: %+v", res)
	}
	if locks := a.Locks(); len(locks) != 1 || locks[0] != (Lock{Name: "Alice", Project: projectA}) {
		t.Fatalf("locks: %v", locks)
	}
}

func TestLockRefusesWhatTheListDoesNotHold(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice"})
	for _, c := range []struct{ name, project string }{{"Alice 2", projectA}, {"", projectA}, {"Alice", ""}, {"Zed", projectA}} {
		if res := a.Lock(c.name, c.project, false); res.Status != LockInvalid {
			t.Errorf("Lock(%q, %q): %+v", c.name, c.project, res)
		}
	}
	if len(a.Locks()) != 0 {
		t.Fatalf("locks: %v", a.Locks())
	}
}

func TestLockedElsewhereAsksBeforeMoving(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	lockOf(a, "Alice", projectA)
	lockOf(a, "Bruno", projectB)
	res := a.Lock("Alice", projectB, false)
	if res.Status != LockElsewhere || res.From != projectA {
		t.Fatalf("lock elsewhere: %+v", res)
	}
	if got := a.LockedFor("Alice"); got != projectA {
		t.Fatalf("a refused move changed the lock: %q", got)
	}
	res = a.Lock("Alice", projectB, true)
	if res.Status != LockDone || res.From != projectA {
		t.Fatalf("move: %+v", res)
	}
	if got := a.LockedFor("Alice"); got != projectB {
		t.Fatalf("after the move: %q", got)
	}
	// The moved name takes the last place of its new project's names.
	if locks := a.Locks(); len(locks) != 2 || locks[0].Name != "Bruno" || locks[1].Name != "Alice" {
		t.Fatalf("order: %v", locks)
	}
}

func TestUnlockFreesTheName(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice"})
	lockOf(a, "Alice", projectA)
	removed, ok := a.Unlock("alice")
	if !ok || removed.Name != "Alice" || removed.Project != projectA {
		t.Fatalf("unlock: %+v %v", removed, ok)
	}
	if _, ok := a.Unlock("Alice"); ok {
		t.Fatalf("a name unlocked twice")
	}
	if name, _ := a.Take("b1"); name != "Alice" {
		t.Fatalf("an unlocked name is drawn again: %q", name)
	}
}

func TestAnAgentWithoutAProjectNeverDrawsALockedName(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	lockOf(a, "Alice", projectA)
	for i := 0; i < 20; i++ {
		owner := fmt.Sprintf("b%d", i)
		if name, _ := a.Take(owner); name == "Alice" {
			t.Fatalf("a locked name was drawn")
		}
		a.Release(owner)
	}
}

func TestARememberedLockedNameIsNotGivenBack(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	a.Prefer("b1", "Alice")
	lockOf(a, "Alice", projectA)
	if name, fresh := a.Take("b1"); name != "Bruno" || !fresh {
		t.Fatalf("remembered name locked since: %q fresh %v", name, fresh)
	}
}

func TestExhaustedListNeverGivesALockedName(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	lockOf(a, "Alice", projectA)
	first, _ := a.Take("b1")
	second, _ := a.Take("b2")
	if first != "Bruno" || second == "Alice" || second == "Bruno" {
		t.Fatalf("names: %q, %q", first, second)
	}
	if second != "Alice 2" && second != "Bruno 2" {
		t.Fatalf("numbered name: %q", second)
	}
}

// A session that started in a project settles on the project's first free locked name, in locking order.
func TestSettleGivesTheProjectsFirstFreeLockedName(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno", "Clara", "Diane"})
	lockOf(a, "Clara", projectA)
	lockOf(a, "Bruno", projectA)
	lockOf(a, "Diane", projectB)

	first, _ := a.Take("b1")
	name, changed := a.Settle("b1", projectA)
	if !changed || name != "Clara" {
		t.Fatalf("first agent of A (took %q): %q changed %v", first, name, changed)
	}
	if owner, _ := a.Owner("Clara"); owner != "b1" || a.Held("b1") != "Clara" {
		t.Fatalf("holder of Clara: %q, b1 holds %q", owner, a.Held("b1"))
	}
	if _, held := a.Owner(first); held {
		t.Fatalf("the name %q the session gave up is still held", first)
	}

	a.Take("b2")
	if name, changed := a.Settle("b2", projectA); !changed || name != "Bruno" {
		t.Fatalf("second agent of A while Clara is live: %q changed %v", name, changed)
	}

	// Both of A's names are live: a third agent keeps an ordinary name.
	ordinary, _ := a.Take("b3")
	if name, changed := a.Settle("b3", projectA); changed || name != ordinary {
		t.Fatalf("third agent of A: %q changed %v", name, changed)
	}
	if got := a.LockedFor(ordinary); got != "" {
		t.Fatalf("an ordinary name is locked for %q", got)
	}
}

func TestSettleKeepsANameAlreadyLockedForTheProject(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	lockOf(a, "Alice", projectA)
	lockOf(a, "Bruno", projectA)
	a.Prefer("b1", "Bruno")
	a.holdLocked("b1", "Bruno")
	if name, changed := a.Settle("b1", projectA); changed || name != "Bruno" {
		t.Fatalf("settle on a project's own name: %q changed %v", name, changed)
	}
}

func TestSettleForAnotherProjectNeverTakesALockedName(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	lockOf(a, "Alice", projectA)
	ordinary, _ := a.Take("b1")
	if name, changed := a.Settle("b1", projectB); changed || name != ordinary || name == "Alice" {
		t.Fatalf("an agent of B: %q changed %v", name, changed)
	}
}

func TestSettleWithoutAProjectOrASessionChangesNothing(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	lockOf(a, "Alice", projectA)
	ordinary, _ := a.Take("b1")
	if name, changed := a.Settle("b1", ""); changed || name != ordinary {
		t.Fatalf("no project: %q changed %v", name, changed)
	}
	if name, changed := a.Settle("nobody", projectA); changed || name != "" {
		t.Fatalf("no session: %q changed %v", name, changed)
	}
}

func TestSettledNameIsRememberedByThePane(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	lockOf(a, "Alice", projectA)
	a.Take("b1")
	a.Settle("b1", projectA)
	a.Release("b1")
	name, fresh := a.Take("b1")
	if name == "Alice" || !fresh {
		// A remembered locked name is never given without its project: the pane settles on it again.
		t.Fatalf("taken again without a project: %q fresh %v", name, fresh)
	}
	if name, changed := a.Settle("b1", projectA); !changed || name != "Alice" {
		t.Fatalf("settled again: %q changed %v", name, changed)
	}
}

func TestUnlockedNameStaysWithItsHolder(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	lockOf(a, "Alice", projectA)
	a.Take("b1")
	a.Settle("b1", projectA)
	a.Unlock("Alice")
	if a.Held("b1") != "Alice" {
		t.Fatalf("a live agent lost its name when it was unlocked: %q", a.Held("b1"))
	}
	if got := a.LockedFor("Alice"); got != "" {
		t.Fatalf("still locked for %q", got)
	}
}

func TestSetLocksCleansWhatItIsGiven(t *testing.T) {
	t.Parallel()
	a := MakeAllocator([]string{"Alice", "Bruno"})
	a.SetLocks([]Lock{
		{Name: " alice ", Project: projectA},
		{Name: "ALICE", Project: projectB},
		{Name: "", Project: projectA},
		{Name: "Bruno", Project: ""},
		{Name: "Bruno", Project: projectB},
	})
	locks := a.Locks()
	if len(locks) != 2 || locks[0] != (Lock{Name: "Alice", Project: projectA}) || locks[1] != (Lock{Name: "Bruno", Project: projectB}) {
		t.Fatalf("locks: %v", locks)
	}
}

func TestConcurrentLocksAndTakesStayConsistent(t *testing.T) {
	t.Parallel()
	names := make([]string, 40)
	for i := range names {
		names[i] = fmt.Sprintf("Name%d", i)
	}
	a := MakeAllocator(names)
	for i := 0; i < 10; i++ {
		lockOf(a, names[i], projectA)
	}
	var wg sync.WaitGroup
	taken := make([]string, 30)
	for i := range taken {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			owner := fmt.Sprintf("b%d", i)
			a.Take(owner)
			a.Settle(owner, projectA)
			taken[i] = a.Held(owner)
		}(i)
	}
	for i := 10; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a.Lock(names[i], projectB, false)
			a.Unlock(names[i])
		}(i)
	}
	wg.Wait()
	seen := map[string]string{}
	locked := 0
	for i, name := range taken {
		if name == "" {
			t.Fatalf("b%d holds no name", i)
		}
		if prev, dup := seen[nameKey(name)]; dup {
			t.Fatalf("%s held by %s and b%d", name, prev, i)
		}
		seen[nameKey(name)] = fmt.Sprintf("b%d", i)
		if a.LockedFor(name) == projectA {
			locked++
		}
	}
	if locked != 10 {
		t.Fatalf("the project's 10 locked names went to %d agents of the project", locked)
	}
}
