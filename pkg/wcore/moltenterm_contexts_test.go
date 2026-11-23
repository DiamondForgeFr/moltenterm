// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func railList(entries ...[2]string) waveobj.WorkspaceList {
	rtn := waveobj.WorkspaceList{}
	for _, e := range entries {
		rtn = append(rtn, &waveobj.WorkspaceListEntry{WorkspaceId: e[0], WindowId: e[1]})
	}
	return rtn
}

// #2476: deleting the workspace a window shows lands on a workspace of the same context before any other.
func TestDeleteLandsOnTheSameContextFirst(t *testing.T) {
	state := contexts.State{
		Contexts: []contexts.Context{{Id: "one"}, {Id: "two"}},
		Of:       map[string]string{"a": "one", "b": "two", "c": "one", "d": "two", "e": "one"},
	}
	list := railList([2]string{"a", ""}, [2]string{"b", ""}, [2]string{"c", ""}, [2]string{"d", ""}, [2]string{"e", ""})
	cases := []struct {
		name    string
		deleted string
		list    waveobj.WorkspaceList
		want    string
	}{
		{"the next one of its context after it", "a", list, "c"},
		{"skips the other context", "b", list, "d"},
		{"wraps to the ones before it", "e", list, "a"},
		{"none in its context: Wave's choice stands", "d", railList([2]string{"d", ""}, [2]string{"a", ""}, [2]string{"c", ""}), ""},
		{"skips a workspace another window shows", "a", railList([2]string{"a", ""}, [2]string{"c", "w2"}, [2]string{"e", ""}), "e"},
		{"every other one is shown: Wave's choice stands", "a", railList([2]string{"a", ""}, [2]string{"c", "w2"}, [2]string{"e", "w3"}), ""},
		{"not in the rail", "ghost", list, ""},
	}
	for _, c := range cases {
		if got := sameContextLanding(state, c.deleted, c.list); got != c.want {
			t.Errorf("%s: landed on %q, want %q", c.name, got, c.want)
		}
	}
}
