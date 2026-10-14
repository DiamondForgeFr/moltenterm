// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

func reviewCtx(ctx LaunchContext) LaunchContext {
	ctx.Env.Getenv = func(name string) string {
		if name == mcpreview.SessionTokenVarName {
			return "token"
		}
		return ""
	}
	return ctx
}

// FR-REV-004 AC3, #505 R1: a review session's agent never gets the coffee approvals' hook; the state hooks and the
// status line stay; its own --strict-mcp-config keeps the browser out.
func TestClaudeReviewSessionPlan(t *testing.T) {
	tree := makeFakeTree(t)
	ctx := reviewCtx(tree.ctx("--permission-mode", "default", "--strict-mcp-config", "--mcp-config=/data/review-mcp.json"))
	ctx.MoltenPath = "/data/bin/molten"
	plan, gen, _ := planOf(t, ctx)
	if got := hookCommands(gen, molten.ClaudePermissionHookEvent); len(got) != 0 {
		t.Fatalf("PermissionRequest hook in a review session: %q", got)
	}
	if len(hookCommands(gen, "Stop")) == 0 || gen.StatusLine == nil {
		t.Fatalf("state hooks and status line: %+v", gen)
	}
	report := molten.AgentIntegrationReport{Added: plan.Added, Skipped: plan.Skipped}
	if report.HasCoffeeApproval() || report.CoffeeApprovalSkipped() != ReasonReviewSession {
		t.Fatalf("report %+v", report)
	}
	if slices.Contains(itemKinds(plan.Added), molten.IntegrationBrowser) {
		t.Fatalf("the browser was added to a review session: %v", plan.Added)
	}
}

func TestCodexReviewSessionPlan(t *testing.T) {
	tree := makeFakeTree(t)
	plan, args := codexPlanAll(t, reviewCtx(tree.codexCtx("--sandbox", "read-only")))
	if slices.ContainsFunc(args, func(a string) bool { return strings.HasPrefix(a, codexPermissionOverrideKey+"=") }) {
		t.Fatalf("hook in a review session: %q", args)
	}
	if skipped := strings.Join(itemNames(plan.Skipped, molten.IntegrationCoffeeApproval), ""); !strings.Contains(skipped, ReasonReviewSession) {
		t.Fatalf("skipped %q", skipped)
	}
}

// The review guide is written next to the launch files, as .md, and swept with them.
func TestWriteLaunchFileExt(t *testing.T) {
	dir := t.TempDir()
	path, created, err := WriteLaunchFileExt(dir, "review-guide", ".md", []byte("# guide"), time.Now())
	if err != nil || !created || filepath.Ext(path) != ".md" {
		t.Fatalf("%s %v %v", path, created, err)
	}
	if _, _, err := WriteLaunchFileExt(dir, "x", ".sh", []byte("x"), time.Now()); err == nil {
		t.Fatal("a .sh launch file was written")
	}
	old := time.Now().Add(-launchFileMaxAge * 2)
	os.Chtimes(path, old, old)
	SweepLaunchFiles(dir, time.Now())
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the old guide was kept: %v", err)
	}
}
