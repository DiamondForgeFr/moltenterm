// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func preparationStep(id string, run string) molten.PipelineStep {
	step := molten.PipelineStep{Id: id}
	step.Run = run
	return step
}

// The release card shows the readiness check as one step of the preparation (#1800): the first phase of the chain
// molten cuts, before the first step that writes anything.
func TestPreparationStartsWithTheReadinessCheckWhenMoltenCutsTheRelease(t *testing.T) {
	steps := []molten.PipelineStep{
		preparationStep("promote", "molten release promote --workflow ci.yml"),
		preparationStep("prepare", "molten release prepare {tag}"),
	}
	run, err := preparationCommand(steps, "1.2.0", "v1.2.0-1", "develop")
	if err != nil {
		t.Fatal(err)
	}
	ready := strings.Index(run, "echo '▶ phase: "+ReleaseReadyStepId+"' && ( molten release ready v1.2.0-1 )")
	promote := strings.Index(run, "'▶ phase: promote'")
	prepare := strings.Index(run, "'▶ phase: prepare'")
	if ready != 0 || promote < ready || prepare < promote {
		t.Fatalf("the readiness check comes first, then the declared steps in order:\n%s", run)
	}
	if !strings.Contains(run, "molten release prepare v1.2.0-1 )") {
		t.Fatalf("the declared steps run as they were: %s", run)
	}

	pr, err := preparationCommand([]molten.PipelineStep{preparationStep("prepare", "molten release prepare {tag} --pr")}, "1.2.0", "v1.2.0", "develop")
	if err != nil || !strings.HasPrefix(pr, "echo '▶ phase: "+ReleaseReadyStepId+"' && ( molten release ready v1.2.0 --pr )") {
		t.Fatalf("a pull-request release is checked for its own flow: %q %v", pr, err)
	}
}

func TestPreparationOfAnotherToolHasNoReadinessCheck(t *testing.T) {
	for _, run := range []string{"echo prepared {tag}", "./scripts/release.sh --prepare {tag}", "molten release promote", "molten releases prepare {tag}"} {
		got, err := preparationCommand([]molten.PipelineStep{preparationStep("prepare", run)}, "1.2.0", "v1.2.0", "develop")
		if err != nil || strings.Contains(got, ReleaseReadyStepId) {
			t.Fatalf("%q: %q %v", run, got, err)
		}
	}
}

func TestReadinessCheckRefusesAHostileTag(t *testing.T) {
	if _, err := preparationCommand([]molten.PipelineStep{preparationStep("prepare", "molten release prepare {tag}")}, "1.0.0", "v1.0.0; touch PWNED", "develop"); err == nil {
		t.Fatal("a hostile tag must be refused")
	}
}
