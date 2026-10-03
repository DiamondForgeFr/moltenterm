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
