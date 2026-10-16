// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// mustBeCoded: every name and reason of a plan carries its code for the companion (#656), and the English is kept.
func mustBeCoded(t *testing.T, what string, plan LaunchPlan) {
	t.Helper()
	if plan.StepAside != "" && plan.StepAsideText == nil {
		t.Errorf("%s: step aside %q has no code", what, plan.StepAside)
	}
	for _, it := range append(append([]molten.IntegrationItem(nil), plan.Added...), plan.Skipped...) {
		if it.Name == "" || it.NameText == nil || it.NameText.Code == "" {
			t.Errorf("%s: item %q has no name code", what, it.Name)
		}
		if it.Reason != "" && (it.ReasonText == nil || it.ReasonText.Code == "") {
			t.Errorf("%s: reason %q has no code", what, it.Reason)
		}
	}
}

func TestPlansAreCoded(t *testing.T) {
	tree := makeFakeTree(t)
	plan, _, _ := planOf(t, tree.ctx())
	mustBeCoded(t, "claude stock", plan)

	tree.write(t, tree.managed, `{"statusLine":{"type":"command","command":"corp"},"allowManagedHooksOnly":true}`)
	plan, _, _ = planOf(t, tree.ctx())
	mustBeCoded(t, "claude managed", plan)
	if len(plan.Skipped) == 0 || plan.Skipped[0].ReasonText.Code != "integration.reason.managedhooksonly" {
		t.Fatalf("managed hooks only: %+v", plan.Skipped)
	}

	tree.write(t, tree.userSettings(), `{"disableAllHooks": true}`)
	plan, _, _ = planOf(t, tree.ctx())
	mustBeCoded(t, "claude disableAllHooks", plan)
	if plan.StepAsideText.Code != "integration.stepaside.disableallhooks" || plan.StepAsideText.Vars["where"] == "" {
		t.Fatalf("disableAllHooks: %+v", plan.StepAsideText)
	}

	codexTree := makeFakeTree(t)
	cplan, _ := codexPlanAll(t, codexTree.codexCtx())
	mustBeCoded(t, "codex stock", cplan)
	codexTree.write(t, codexTree.codexConfig(), `notify = ["my-notify"]`+"\n")
	cplan, _ = codexPlanAll(t, codexTree.codexCtx("-c", "notify=[\"x\"]"))
	mustBeCoded(t, "codex own notify", cplan)
}

func TestUnreadableFileIsCoded(t *testing.T) {
	display := filepath.Join("~", ".claude.json")
	err := unreadableFile(display)
	text := uimsg.TextOf(err)
	if err.Error() != display+" could not be read" || text == nil || text.Code != "integration.reason.fileunreadable" || text.Vars["where"] != display {
		t.Fatalf("unreadableFile: %q %+v", err, text)
	}
}

func TestStepAsideTextOf(t *testing.T) {
	for _, reason := range []string{StepAsideOutsidePane, StepAsideNested, StepAsideTurnedOff, StepAsidePassThrough,
		StepAsideSettingsOff, StepAsideSettingsAgentOff, StepAsideSettingsUnknown} {
		if text := StepAsideTextOf(reason); text == nil || text.Code == "" {
			t.Errorf("%q has no code", reason)
		}
	}
	if StepAsideTextOf("something else") != nil {
		t.Fatal("an unknown reason got a code")
	}
}
