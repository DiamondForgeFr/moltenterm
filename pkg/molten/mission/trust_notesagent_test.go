// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2121: the release runs versions.notesagent on commit and issue text, so declaring or changing it asks for the
// commands approval again, and the approval shows it.
func TestNotesAgentIsATrustedCommand(t *testing.T) {
	t.Parallel()
	pipeline := func(notesAgent ...string) *molten.Pipeline {
		return &molten.Pipeline{Versions: &molten.PipelineVersions{NotesAgent: notesAgent}}
	}
	none := CommandsHash(PipelineCommands(pipeline()))
	declared := PipelineCommands(pipeline("claude", "-p"))
	if len(declared) != 1 || declared[0].Kind != "notesagent" || declared[0].Run != "claude -p" {
		t.Fatalf("the approval lists the notes agent: %+v", declared)
	}
	if CommandsHash(declared) == none {
		t.Fatal("declaring a notes agent asks again")
	}
	if CommandsHash(PipelineCommands(pipeline("claude", "-p", "--dangerously-skip-permissions"))) == CommandsHash(declared) {
		t.Fatal("changing the notes agent asks again")
	}
	if CommandsHash(PipelineCommands(pipeline("my agent"))) == CommandsHash(PipelineCommands(pipeline("my", "agent"))) {
		t.Fatal("two different argvs never hash the same")
	}
	if got := PipelineCommands(pipeline("sh", "-c", "echo hi")); got[0].Run != "sh -c 'echo hi'" {
		t.Fatalf("the argv is shown as a shell reads it: %q", got[0].Run)
	}
}
