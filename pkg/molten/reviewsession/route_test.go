// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// DS-REV-011: only a window starts, ends or selects; a terminal (where an agent runs) may only read; a source the
// router did not tie to its link ("") is refused; the MCP hello comes from a local terminal only.
func TestRouteSources(t *testing.T) {
	l := &routeLink{manager: MakeManager(Env{})}
	ctx := context.Background()
	start := map[string]any{"repo": "o/r", "number": 1}
	for _, source := range []string{"", "proc:abc", "conn:host"} {
		if _, err := l.handle(ctx, mcpreview.StartCommand, source, start); err == nil {
			t.Errorf("start from %q accepted", source)
		}
		if _, err := l.handle(ctx, mcpreview.EndCommand, source, map[string]any{"id": "x"}); err == nil {
			t.Errorf("end from %q accepted", source)
		}
	}
	if _, err := l.handle(ctx, mcpreview.ListCommand, "proc:abc", nil); err != nil {
		t.Errorf("list from a local terminal: %v", err)
	}
	if _, err := l.handle(ctx, mcpreview.ListCommand, "", nil); err == nil {
		t.Error("list from an unknown source accepted")
	}
	for _, source := range []string{"", "tab:t1"} {
		if _, err := l.handle(ctx, mcpreview.HelloCommand, source, map[string]any{"token": "t", "sessiontoken": "s"}); err == nil || !strings.Contains(err.Error(), mcpreview.ErrNotInMoltenTerm) {
			t.Errorf("hello from %q: %v", source, err)
		}
	}
	// A window's start is checked as a request: a bad one is refused before anything runs.
	if _, err := l.handle(ctx, mcpreview.StartCommand, "tab:t1", start); err == nil || !strings.Contains(err.Error(), "projectdir") {
		t.Errorf("start from a window: %v", err)
	}
}
