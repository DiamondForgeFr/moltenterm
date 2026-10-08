// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"sync"
	"testing"
)

func TestParseGenerationMark(t *testing.T) {
	mark, ok := ParseShellMark(`16162;MOLTEN;{"gen":3}`)
	if !ok || mark.Kind != ShellMarkGeneration || mark.Gen != 3 {
		t.Fatalf("got %+v %v", mark, ok)
	}
	for _, bad := range []string{`16162;MOLTEN;{"gen":0}`, `16162;MOLTEN;{}`, `16162;MOLTEN;nope`} {
		if _, ok := ParseShellMark(bad); ok {
			t.Errorf("%s parsed", bad)
		}
	}
}

// A generation report reaches the observers and leaves the agent states alone; the other marks reach both.
func TestShellMarkObservers(t *testing.T) {
	var lock sync.Mutex
	var seen []ShellMark
	OnShellMark(func(blockId string, mark ShellMark) {
		if blockId != "obs-block" {
			return
		}
		lock.Lock()
		defer lock.Unlock()
		seen = append(seen, mark)
	})
	w := makeAttentionWatcher(func(string, AttentionSignal) {})
	w.handle("obs-block", []byte("\x1b]16162;MOLTEN;{\"gen\":2}\x07\x1b]16162;A\x07"))
	lock.Lock()
	defer lock.Unlock()
	if len(seen) != 2 || seen[0].Gen != 2 || seen[1].Kind != ShellMarkPrompt {
		t.Fatalf("got %+v", seen)
	}
}
