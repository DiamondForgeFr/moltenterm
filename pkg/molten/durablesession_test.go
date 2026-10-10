// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"strings"
	"testing"
)

func TestShortSessionId(t *testing.T) {
	if got := ShortSessionId("0123456789abcdef"); got != "01234567" {
		t.Fatalf("short id: %q", got)
	}
	if got := ShortSessionId("abc"); got != "abc" {
		t.Fatalf("short id of a short id: %q", got)
	}
}

func TestPanePlacementSplitAction(t *testing.T) {
	cases := []struct {
		place      PanePlacement
		horizontal bool
		position   string
		ok         bool
	}{
		{PanePlacement{TargetBlockId: "b", Split: "right"}, true, "after", true},
		{PanePlacement{TargetBlockId: "b", Split: "left"}, true, "before", true},
		{PanePlacement{TargetBlockId: "b", Split: "down"}, false, "after", true},
		{PanePlacement{TargetBlockId: "b", Split: "up"}, false, "before", true},
		{PanePlacement{TargetBlockId: "b", Split: "center"}, false, "", false},
		{PanePlacement{Split: "right"}, false, "", false},
		{PanePlacement{}, false, "", false},
	}
	for _, c := range cases {
		horizontal, position, ok := c.place.SplitAction()
		if horizontal != c.horizontal || position != c.position || ok != c.ok {
			t.Errorf("%+v: got %v %q %v", c.place, horizontal, position, ok)
		}
	}
}

func TestResolveSessionId(t *testing.T) {
	ids := []string{"abcd1111-x", "abcd2222-y", "ef001234-z"}
	cases := []struct {
		prefix string
		want   string
		errHas string
	}{
		{"ef00", "ef001234-z", ""},
		{"abcd1", "abcd1111-x", ""},
		{"abcd2222-y", "abcd2222-y", ""},
		{"abcd", "", "matches 2 sessions (abcd1111, abcd2222)"},
		{"zz", "", "no running session"},
		{"  ", "", "no session id"},
	}
	for _, c := range cases {
		got, err := ResolveSessionId(c.prefix, ids)
		if c.errHas != "" {
			if err == nil || !strings.Contains(err.Error(), c.errHas) {
				t.Fatalf("%q: want error with %q, got %v", c.prefix, c.errHas, err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Fatalf("%q: got %q %v, want %q", c.prefix, got, err, c.want)
		}
	}
}

func TestSessionConnState(t *testing.T) {
	cases := []struct {
		local bool
		host  string
		job   string
		want  string
	}{
		{true, "", "connected", SessionConnConnected},
		{true, "", "connecting", SessionConnReconnecting},
		{true, "", "disconnected", SessionConnDisconnected},
		{false, "connecting", "disconnected", SessionConnReconnecting},
		{false, "connected", "connecting", SessionConnReconnecting},
		{false, "connected", "connected", SessionConnConnected},
		{false, "connected", "disconnected", SessionConnDisconnected},
		{false, "disconnected", "connected", SessionConnDisconnected},
		{false, "error", "disconnected", SessionConnDisconnected},
		{false, "", "", SessionConnDisconnected},
	}
	for _, c := range cases {
		if got := SessionConnState(c.local, c.host, c.job); got != c.want {
			t.Fatalf("local=%v host=%q job=%q: got %q, want %q", c.local, c.host, c.job, got, c.want)
		}
	}
}
