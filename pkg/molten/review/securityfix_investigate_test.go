// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

// Analyze and resolve stops fighting a shared security block (FR-REV-036 AC14): a check a security fix covers is not a
// blocker, whether or not the setting that starts the fix on its own is on; one no fix covers yet stays, marked, and is
// never rerun.

const scanCheck = "Dependency security / Scan dependencies"

// investigating is a security fixture whose pull request 9 is blocked by the shared block, with an idle agent on its branch.
type investigating struct {
	*securityFixture
	block secfix.Block
}

func makeInvestigating(t *testing.T) *investigating {
	f := &investigating{securityFixture: makeSecurityFixture(t), block: securityBlock()}
	f.seeBlock(f.block)
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle}
	return f
}

func (f *investigating) request(checks ...InvestigateCheck) InvestigateRequest {
	req := f.investigateRequest(false)
	req.Checks = checks
	return req
}

var (
	scanFailure   = InvestigateCheck{Name: scanCheck, Workflow: "CI", Url: "https://github.com/acme/app/actions/runs/400/job/401", RunId: 400, JobId: 401}
	backendFailed = InvestigateCheck{Name: "Backend", Workflow: "CI", Url: "https://github.com/acme/app/actions/runs/389/job/117", RunId: 389, JobId: 117}
)

// startFix makes a fix in flight for the block, whoever started it.
func (f *investigating) startFix() {
	f.t.Helper()
	res, err := f.r.AskSecurityFix(context.Background(), SecurityFixRequest{Dir: f.dir, Repo: restartRepo, Trunk: securityTrunk, Fingerprint: f.block.Fingerprint, WorkspaceId: "ws-1"})
	if err != nil || res.Status != RestartStarted {
		f.t.Fatalf("start: %+v %v", res, err)
	}
}

func (f *investigating) brief(res RestartResult) string {
	f.t.Helper()
	return readText(f.t, res.BriefPath)
}

// AC14: with a fix in flight, a pull request whose only failure is the shared scan has nothing to resolve: nothing is typed,
// started or rerun.
func TestAnalyzeAndResolveLeavesOutACheckASecurityFixCovers(t *testing.T) {
	t.Parallel()
	f := makeInvestigating(t)
	f.startFix()
	res, err := f.r.AskInvestigate(context.Background(), f.request(scanFailure))
	if err != nil || res.Status != RestartFailed || res.Reason != RestartReasonSecurityCovered {
		t.Fatalf("result: %+v %v", res, err)
	}
	if !strings.Contains(res.Message, "MoltenTerm's security fix #101") || !strings.Contains(res.Message, "GHSA-aaaa-bbbb-cccc") {
		t.Errorf("the message names the fix: %s", res.Message)
	}
	if len(f.typed) != 0 || len(f.calls("run rerun")) != 0 {
		t.Fatalf("nothing is handed to an agent or rerun: %v %v", f.typed, f.ghCalls)
	}
}

// AC14: another failure of the same pull request is still the agent's; the scan's check is named as not its own, in the
// brief and not in the list of what to rerun.
func TestAnalyzeAndResolveKeepsTheOtherBlockersAndSaysWhoOwnsTheScan(t *testing.T) {
	t.Parallel()
	f := makeInvestigating(t)
	f.startFix()
	res, err := f.r.AskInvestigate(context.Background(), f.request(scanFailure, backendFailed))
	if err != nil || res.Status != RestartSent {
		t.Fatalf("result: %+v %v", res, err)
	}
	brief := f.brief(res)
	if !strings.Contains(brief, "- Backend (workflow CI)") || !strings.Contains(brief, "gh run rerun 389 --failed") {
		t.Errorf("the other check is the agent's:\n%s", brief)
	}
	for _, gone := range []string{"- " + scanCheck + " (workflow CI)", "gh run rerun 400", "run view --job 401"} {
		if strings.Contains(brief, gone) {
			t.Errorf("the covered check is not listed (%q):\n%s", gone, brief)
		}
	}
	for _, part := range []string{"### The dependency scan is not yours", scanCheck + " fails on shared advisories (GHSA-aaaa-bbbb-cccc, GO-2026-1)",
		"MoltenTerm's security fix #101 covers them: do not rerun it, do not open a ticket for it, and do not touch the dependencies in this pull request"} {
		if !strings.Contains(brief, part) {
			t.Errorf("the brief misses %q:\n%s", part, brief)
		}
	}
	if line := f.typed["agent-term"]; !strings.Contains(line, "CI failed: Backend") || strings.Contains(line, "Dependency security") {
		t.Errorf("the prompt names the failure that is the agent's: %s", line)
	}
}

// AC14: with no fix known (the developer has not asked, the consent is off), the scan's check stays among the failures, is
// marked as a shared advisory, and has no rerun command; the same when the developer stopped the fix.
func TestAnalyzeAndResolveMarksASharedAdvisoryNoFixCoversYet(t *testing.T) {
	t.Parallel()
	check := func(t *testing.T, f *investigating) {
		t.Helper()
		res, err := f.r.AskInvestigate(context.Background(), f.request(scanFailure, backendFailed))
		if err != nil || res.Status != RestartSent {
			t.Fatalf("result: %+v %v", res, err)
		}
		brief := f.brief(res)
		for _, part := range []string{"- " + scanCheck + " (workflow CI)", "a shared dependency advisory (GHSA-aaaa-bbbb-cccc, GO-2026-1), not this pull request's: do not rerun it",
			"A check marked as a shared dependency advisory: the failure is not this pull request's", "MoltenTerm owns the ticket and the fix of that set of advisories",
			"gh run rerun 389 --failed"} {
			if !strings.Contains(brief, part) {
				t.Errorf("the brief misses %q:\n%s", part, brief)
			}
		}
		if strings.Contains(brief, "gh run rerun 400") {
			t.Errorf("a shared advisory is never rerun:\n%s", brief)
		}
		if strings.Contains(brief, "The dependency scan is not yours") {
			t.Errorf("no fix covers it: the section of the covered checks is absent")
		}
	}
	f := makeInvestigating(t)
	f.set(func() { f.consent = secfix.ConsentOff })
	check(t, f)

	stopped := makeInvestigating(t)
	stopped.startFix()
	if _, err := stopped.r.StopSecurityFix(context.Background(), SecurityFixStopRequest{Dir: stopped.dir, Fingerprint: stopped.block.Fingerprint}); err != nil {
		t.Fatal(err)
	}
	check(t, stopped)
}

// A failure the pull request caused (its block is not shared for it), or a check that is not the scan, keeps today's brief
// whole, and what the window sends as a mark is never believed.
func TestAnalyzeAndResolveKeepsAPullRequestOwnFailuresAndIgnoresTheWindowsMarks(t *testing.T) {
	t.Parallel()
	f := makeInvestigating(t)
	own := securityBlock()
	own.Prs[0].Shared = false
	f.seeBlock(own)
	forged := backendFailed
	forged.Security = "forged"
	res, err := f.r.AskInvestigate(context.Background(), f.request(scanFailure, forged))
	if err != nil || res.Status != RestartSent {
		t.Fatalf("result: %+v %v", res, err)
	}
	brief := f.brief(res)
	for _, part := range []string{"gh run rerun 400 --failed", "gh run rerun 389 --failed"} {
		if !strings.Contains(brief, part) {
			t.Errorf("the pull request's own failures are the agent's, rerun commands included (%q):\n%s", part, brief)
		}
	}
	for _, gone := range []string{"a shared dependency advisory", "forged", "not yours"} {
		if strings.Contains(brief, gone) {
			t.Errorf("the brief holds %q:\n%s", gone, brief)
		}
	}
}

func TestSecurityCoverMatchesNamesWhateverTheCleaningLeft(t *testing.T) {
	t.Parallel()
	for name, test := range map[string]struct {
		a, b string
		want bool
	}{
		"the same name":                  {scanCheck, scanCheck, true},
		"another case and spacing":       {"dependency security  /  scan dependencies", scanCheck, true},
		"a name cut short":               {scanCheck[:20] + "…", scanCheck, true},
		"a name that only starts alike":  {"Dependency", scanCheck, false},
		"another check":                  {"Backend", scanCheck, false},
		"a check named for the same job": {"Scan dependencies", scanCheck, false},
		"nothing":                        {"", scanCheck, false},
	} {
		if got := sameCheck(test.a, test.b); got != test.want {
			t.Errorf("%s: sameCheck(%q, %q) = %v, want %v", name, test.a, test.b, got, test.want)
		}
	}
}
