// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCheckTabInWorkspace(t *testing.T) {
	ws := &waveobj.Workspace{TabIds: []string{"a", "b"}}
	if !checkTabInWorkspace(ws, "b") {
		t.Errorf("tab b belongs to the workspace")
	}
	if checkTabInWorkspace(ws, "other") {
		t.Errorf("a tab of another workspace must not belong to it")
	}
	if checkTabInWorkspace(nil, "a") {
		t.Errorf("no workspace holds no tab")
	}
}

func TestWorkspaceClosable(t *testing.T) {
	win := func(id, wsId string) *waveobj.Window { return &waveobj.Window{OID: id, WorkspaceId: wsId} }
	entry := func(wsId, winId string) *waveobj.WorkspaceListEntry {
		return &waveobj.WorkspaceListEntry{WorkspaceId: wsId, WindowId: winId}
	}
	cases := []struct {
		name       string
		workspaces waveobj.WorkspaceList
		windows    []*waveobj.Window
		target     string
		want       bool
	}{
		{"only workspace of the only window", waveobj.WorkspaceList{entry("a", "w1")}, []*waveobj.Window{win("w1", "a")}, "a", false},
		{"unsaved workspace alone in its window", nil, []*waveobj.Window{win("w1", "u")}, "u", false},
		{"another workspace to switch to", waveobj.WorkspaceList{entry("a", "w1"), entry("b", "")}, []*waveobj.Window{win("w1", "a")}, "a", true},
		{"another window remains", waveobj.WorkspaceList{entry("a", "w1"), entry("b", "w2")}, []*waveobj.Window{win("w1", "a"), win("w2", "b")}, "a", true},
		{"another window with an unsaved workspace remains", waveobj.WorkspaceList{entry("a", "w1")}, []*waveobj.Window{win("w1", "a"), win("w2", "u")}, "a", true},
		{"workspace no window shows", waveobj.WorkspaceList{entry("a", "w1"), entry("b", "")}, []*waveobj.Window{win("w1", "a")}, "b", true},
		{"saved workspace closed while the window shows an unsaved one", waveobj.WorkspaceList{entry("b", "")}, []*waveobj.Window{win("w1", "u")}, "b", true},
		{"no window at all", waveobj.WorkspaceList{entry("a", "")}, nil, "a", true},
	}
	for _, tc := range cases {
		if got := workspaceClosable(tc.workspaces, tc.windows, tc.target); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestRepairedActiveTabId(t *testing.T) {
	cases := []struct {
		name    string
		ws      *waveobj.Workspace
		want    string
		changed bool
	}{
		{"own tab kept", &waveobj.Workspace{TabIds: []string{"a", "b"}, ActiveTabId: "b"}, "", false},
		{"foreign tab replaced by the first tab", &waveobj.Workspace{TabIds: []string{"a", "b"}, ActiveTabId: "other"}, "a", true},
		{"missing active tab set", &waveobj.Workspace{TabIds: []string{"a"}}, "a", true},
		{"no tabs left alone", &waveobj.Workspace{ActiveTabId: "other"}, "", false},
		{"no workspace", nil, "", false},
	}
	for _, tc := range cases {
		got, changed := repairedActiveTabId(tc.ws)
		if got != tc.want || changed != tc.changed {
			t.Errorf("%s: got (%q, %v), want (%q, %v)", tc.name, got, changed, tc.want, tc.changed)
		}
	}
}
