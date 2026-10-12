// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestFormatMoltenSessions(t *testing.T) {
	now := time.UnixMilli(10_000_000)
	sessions := []molten.DurableSession{
		{Id: "a1b2c3d4e5", ShortId: "a1b2c3d4", AgentName: "Claude Code", AgentState: "working", Folder: "/srv/app",
			Worktree: &molten.SessionWorktree{Path: "/srv/app-wt", Branch: "feature/1-x"}, WorkspaceName: "App", TabName: "T1",
			BlockId: "blk-1", Shown: true, LastOutputAt: now.Add(-5 * time.Minute).UnixMilli()},
		{Id: "ffee001122", ShortId: "ffee0011", Connection: "build-box", ConnState: molten.SessionConnDisconnected,
			Command: "make watch", Reason: molten.SessionReasonDetached},
	}
	out := formatMoltenSessions(sessions, "blk-1", now)
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 4 || !strings.HasPrefix(lines[0], "ID") || !strings.HasPrefix(lines[1], "a1b2c3d4*") || lines[3] != "* this terminal" {
		t.Fatalf("table:\n%s", out)
	}
	for _, want := range []string{"Claude Code (working)", "App · T1", "/srv/app [feature/1-x]", "5m", "build-box (disconnected)", "make watch", "no pane"} {
		if !strings.Contains(out, want) {
			t.Fatalf("table lacks %q:\n%s", want, out)
		}
	}
	// Columns line up: the second column starts at the same place on every row.
	col := strings.Index(lines[0], "HOST")
	if strings.Index(lines[1], "local") != col || strings.Index(lines[2], "build-box") != col {
		t.Fatalf("columns do not line up:\n%s", out)
	}
	if got := formatMoltenSessions(nil, "", now); got != "No session is running.\n" {
		t.Fatalf("empty list %q", got)
	}
	if got := moltenSessionIdsText(sessions); got != "running sessions: a1b2c3d4, ffee0011" {
		t.Fatalf("ids %q", got)
	}
}
