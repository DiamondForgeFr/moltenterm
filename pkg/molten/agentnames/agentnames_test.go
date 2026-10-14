// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentnames

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

func TestNamesAreUniqueAndNoAgentName(t *testing.T) {
	seen := map[string]bool{}
	for _, n := range Names {
		key := nameKey(n)
		if seen[key] {
			t.Fatalf("%s twice in the list", n)
		}
		seen[key] = true
		if strings.TrimSpace(n) != n || n == "" {
			t.Fatalf("bad name %q", n)
		}
	}
	for _, agent := range []string{"claude", "codex", "gemini", "kimi"} {
		if seen[agent] {
			t.Fatalf("%s is an agent's name", agent)
		}
	}
}

func TestTakeGivesDistinctNames(t *testing.T) {
	a := MakeAllocator(Names)
	got := map[string]string{}
	for i := 0; i < len(Names); i++ {
		owner := fmt.Sprintf("block-%d", i)
		name, fresh := a.Take(owner)
		if !fresh {
			t.Fatalf("%s: first name not fresh", owner)
		}
		if prev, dup := got[nameKey(name)]; dup {
			t.Fatalf("%s given to %s and %s", name, prev, owner)
		}
		got[nameKey(name)] = owner
	}
}

func TestTakeKeepsTheHeldName(t *testing.T) {
	a := MakeAllocator(Names)
	first, _ := a.Take("b1")
	again, fresh := a.Take("b1")
	if again != first || fresh {
		t.Fatalf("held name changed: %s then %s (fresh %v)", first, again, fresh)
	}
}

func TestReleaseFreesTheName(t *testing.T) {
	a := MakeAllocator([]string{"Alice", "Bruno"})
	alice, _ := a.Take("b1")
	a.Release("b1")
	if _, held := a.Owner(alice); held {
		t.Fatalf("%s still held after release", alice)
	}
	a.intn = func(n int) int { return 0 }
	a.Forget("b1")
	name, _ := a.Take("b2")
	if name != "Alice" {
		t.Fatalf("freed name not drawn again: %s", name)
	}
}

func TestResumeInTheSamePaneKeepsTheName(t *testing.T) {
	a := MakeAllocator(Names)
	first, _ := a.Take("b1")
	a.Release("b1")
	again, fresh := a.Take("b1")
	if again != first || fresh {
		t.Fatalf("resumed pane got %s, had %s", again, first)
	}
}

func TestRememberedNameTakenMeanwhileGivesAnother(t *testing.T) {
	a := MakeAllocator([]string{"Alice", "Bruno"})
	a.intn = func(n int) int { return 0 }
	a.Take("b1")
	a.Release("b1")
	a.Forget("b1")
	a.Prefer("b1", "Alice")
	if name, _ := a.Take("b2"); name != "Alice" {
		t.Fatalf("b2 got %s", name)
	}
	name, fresh := a.Take("b1")
	if name != "Bruno" || !fresh {
		t.Fatalf("b1 got %s (fresh %v), want Bruno", name, fresh)
	}
}

func TestPreferAfterRestart(t *testing.T) {
	a := MakeAllocator(Names)
	a.Prefer("b1", "Jérôme")
	name, fresh := a.Take("b1")
	if name != "Jérôme" || fresh {
		t.Fatalf("got %s (fresh %v)", name, fresh)
	}
	a.Prefer("b1", "Alice")
	if a.Held("b1") != "Jérôme" {
		t.Fatalf("prefer changed a held name")
	}
}

func TestExhaustionAddsANumberedSuffix(t *testing.T) {
	a := MakeAllocator([]string{"Alice", "Bruno"})
	a.intn = func(n int) int { return 0 }
	a.Take("b1")
	a.Take("b2")
	third, _ := a.Take("b3")
	fourth, _ := a.Take("b4")
	if third != "Alice 2" || fourth != "Alice 3" {
		t.Fatalf("got %s and %s", third, fourth)
	}
	a.Release("b3")
	if again, _ := a.Take("b5"); again != "Alice 2" {
		t.Fatalf("freed suffix not reused: %s", again)
	}
}

func TestEmptyListStillNames(t *testing.T) {
	a := MakeAllocator(nil)
	n1, _ := a.Take("b1")
	n2, _ := a.Take("b2")
	if n1 == "" || n1 == n2 {
		t.Fatalf("got %q and %q", n1, n2)
	}
}

func TestNamesCompareWithoutCase(t *testing.T) {
	a := MakeAllocator([]string{"alice", "Bruno"})
	a.Prefer("b1", "ALICE")
	a.Take("b1")
	a.intn = func(n int) int { return 0 }
	if name, _ := a.Take("b2"); name != "Bruno" {
		t.Fatalf("got %s, alice is held as ALICE", name)
	}
	if owner, ok := a.Owner("Alice"); !ok || owner != "b1" {
		t.Fatalf("owner of Alice: %s %v", owner, ok)
	}
}

func TestConcurrentTakesStayUnique(t *testing.T) {
	a := MakeAllocator(Names)
	var wg sync.WaitGroup
	var lock sync.Mutex
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name, _ := a.Take(fmt.Sprintf("b%d", i))
			lock.Lock()
			defer lock.Unlock()
			if seen[nameKey(name)] {
				t.Errorf("%s given twice", name)
			}
			seen[nameKey(name)] = true
		}(i)
	}
	wg.Wait()
}
