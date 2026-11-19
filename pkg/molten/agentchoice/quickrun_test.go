// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentchoice

import (
	"reflect"
	"testing"
)

// #2392: the companion's ticket sentences come from the text they are given alone; Claude Code loses its reading tools
// on top of every guard of the quick form, and Codex keeps its quick form as it is.
func TestTextOnlyPrintArgv(t *testing.T) {
	quick := QuickPrintArgv("claude", "/p")
	got := TextOnlyPrintArgv("claude", "/p")
	want := append(append([]string{}, quick...), ClaudeNoReadTools...)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("claude: %v", got)
	}
	if got := TextOnlyPrintArgv("codex", "/p"); !reflect.DeepEqual(got, QuickPrintArgv("codex", "/p")) {
		t.Errorf("codex: %v", got)
	}
	if TextOnlyPrintArgv("kimi", "/p") != nil {
		t.Error("kimi has no quick form and is never started")
	}
}
