// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Closing the view on screen returns to the one shown before it, whichever side it sits on (#1345).
func TestNextActiveTabReturnsToThePreviousView(t *testing.T) {
	ws := &waveobj.Workspace{TabIds: []string{"project", "work", "other", "new"}, ActiveTabId: "project", Meta: waveobj.MetaMapType{}}
	moltenRememberActiveTab(ws, "other")
	ws.ActiveTabId = "other"
	moltenRememberActiveTab(ws, "new")
	ws.ActiveTabId = "new"
	ws.TabIds = []string{"project", "work", "other"}
	if got := moltenNextActiveTab(ws, 3, &waveobj.Tab{OID: "new"}); got != "other" {
		t.Errorf("got %q, want other", got)
	}
	ws.TabIds = []string{"project", "work"}
	if got := moltenNextActiveTab(ws, 2, &waveobj.Tab{OID: "other"}); got != "project" {
		t.Errorf("got %q, want project", got)
	}
}

// The tabs after DeleteTab took the closed tab (at idx 2, between "project" and "other") out of the list.
func TestNextActiveTabReturnsToOpener(t *testing.T) {
	opened := func(opener string) *waveobj.Tab {
		if opener == "" {
			return &waveobj.Tab{OID: "review"}
		}
		return &waveobj.Tab{OID: "review", Meta: waveobj.MetaMapType{molten.OpenerTabMetaKey: opener}}
	}
	cases := []struct {
		name   string
		tabs   []string
		hidden []string
		closed *waveobj.Tab
		want   string
	}{
		{"opener still there", []string{"project", "work", "other"}, nil, opened("project"), "project"},
		{"opener closed since", []string{"work", "project2", "other"}, nil, opened("project"), "project2"},
		{"opener hidden", []string{"agent", "work", "other"}, []string{"agent"}, opened("agent"), "work"},
		{"tab made by hand", []string{"project", "work", "other"}, nil, opened(""), "work"},
		{"no tab object", []string{"project", "work", "other"}, nil, nil, "work"},
	}
	for _, tc := range cases {
		ws := &waveobj.Workspace{TabIds: tc.tabs, Meta: waveobj.MetaMapType{}}
		if tc.hidden != nil {
			molten.SetHiddenTabIds(ws, tc.hidden)
		}
		if got := moltenNextActiveTab(ws, 2, tc.closed); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}
