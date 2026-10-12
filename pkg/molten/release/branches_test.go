// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// A project whose harness releases from master (#415): the pipeline declares no branches, .saasfoundry.json says
// workflow.releaseBranch.
func makeMasterFixture(t *testing.T) *fixture {
	t.Helper()
	f := makeFixture(t)
	writeFile(t, filepath.Join(f.checkout, ".molten", "project.json"), strings.Replace(fixtureProject, `    "branches": { "trunk": "develop", "release": "main" },
`, "", 1))
	writeFile(t, filepath.Join(f.checkout, ".saasfoundry.json"), `{"mainBranch": "main", "workflow": {"workingBranch": "develop", "prTargetBranch": "develop", "releaseBranch": "master"}}`+"\n")
	gitIn(t, f.checkout, "add", "-A")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "chore(#1): release from master")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	return f
}

func TestPromoteUsesTheHarnessReleaseBranch(t *testing.T) {
	f := makeMasterFixture(t)
	ctx := context.Background()
	mustFail(t, f, "promote without master", f.env().Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}, DryRun: true}),
		"origin has no master branch, the release branch (from .saasfoundry.json workflow.releaseBranch)")

	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop~1:refs/heads/master")
	f.out.Reset()
	mustRun(t, f, "promote --dry-run", f.env().Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}, DryRun: true}))
	out := f.out.String()
	if !strings.Contains(out, "reach master (fast-forward)") || !strings.Contains(out, "--dry-run: nothing was pushed") {
		t.Fatalf("want a fast-forward of develop onto master, got:\n%s", out)
	}
	if f.originRef(t, "master") == f.originRef(t, "develop") {
		t.Fatalf("a dry run moved master")
	}
	mustRun(t, f, "promote", f.env().Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	if f.originRef(t, "master") != f.originRef(t, "develop") {
		t.Fatalf("master was not promoted")
	}
	if f.originRef(t, "main") == f.originRef(t, "develop") {
		t.Fatalf("main was moved although the project releases from master")
	}
}
