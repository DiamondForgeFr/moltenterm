// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2365: the cut runs release.preflight before it tags, so declaring or changing a check asks for the commands
// approval again, and the approval shows it. The fix text is advice, not a command: editing it asks nothing.
func TestPreflightChecksAreTrustedCommands(t *testing.T) {
	t.Parallel()
	pipeline := func(checks ...molten.PipelineCheck) *molten.Pipeline {
		return &molten.Pipeline{Release: &molten.PipelineRelease{Preflight: checks}}
	}
	none := CommandsHash(PipelineCommands(pipeline()))
	declared := PipelineCommands(pipeline(molten.PipelineCheck{Id: "scan", Title: "Scan", Run: "node scripts/scan.mjs", Fix: "Read the report"}))
	if len(declared) != 1 || declared[0].Kind != "preflight" || declared[0].Id != "scan" || declared[0].Run != "node scripts/scan.mjs" {
		t.Fatalf("the approval lists the check: %+v", declared)
	}
	if CommandsHash(declared) == none {
		t.Fatal("declaring a check asks again")
	}
	changedRun := pipeline(molten.PipelineCheck{Id: "scan", Run: "node scripts/other.mjs"})
	if CommandsHash(PipelineCommands(changedRun)) == CommandsHash(declared) {
		t.Fatal("changing a check's command asks again")
	}
	changedCwd := pipeline(molten.PipelineCheck{Id: "scan", Run: "node scripts/scan.mjs", Cwd: "tools"})
	if CommandsHash(PipelineCommands(changedCwd)) == CommandsHash(declared) {
		t.Fatal("changing a check's folder asks again")
	}
	reworded := pipeline(molten.PipelineCheck{Id: "scan", Title: "Another title", Run: "node scripts/scan.mjs", Fix: "Another fix"})
	if CommandsHash(PipelineCommands(reworded)) != CommandsHash(declared) {
		t.Fatal("rewording a title or a fix asks nothing")
	}
}
