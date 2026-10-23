// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// Analyze and resolve (#1020): every blocker of a PR in one brief, in order.

func (f *restartFixture) agentOnBranch() {
	tree := f.agentTreeOnBranch()
	f.terms[realOf(tree)] = []mission.WorktreeTerminal{{BlockId: "agent-term"}}
	f.runs["agent-term"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Victoire"}
}

func textInOrder(t *testing.T, text string, parts ...string) {
	t.Helper()
	last := -1
	for _, part := range parts {
		at := strings.Index(text, part)
		if at < 0 {
			t.Errorf("missing %q in:\n%s", part, text)
			return
		}
		if at < last {
			t.Errorf("%q comes too early in:\n%s", part, text)
		}
		last = at
	}
}

// AC: behind its base, a failed remote check and a failed local CI status → one brief, the three blockers in order.
func TestAnalyzeAndResolveListsTheBlockersInOrder(t *testing.T) {
	f := makeRestartFixture(t)
	f.agentOnBranch()
	req := f.investigateRequest(false)
	req.Merge = InvestigateMergeBehind
	req.Checks = append(req.Checks, InvestigateCheck{Name: "local-e2e", Url: "https://github.com/o/r/commit/abc", Local: true})
	res, err := f.r.AskInvestigate(context.Background(), req)
	if err != nil || res.Status != RestartSent {
		t.Fatalf("result: %+v %v", res, err)
	}
	if len(f.typed) != 1 {
		t.Fatalf("one prompt to the agent on the branch: %v", f.typed)
	}
	line := f.typed["agent-term"]
	checkInvestigatePrompt(t, line, res.BriefPath)
	textInOrder(t, line, "1. behind develop: rebase on origin/develop", "2. CI failed: Backend", "3. local CI failed: local-e2e (molten ci run)")
	brief := readText(t, res.BriefPath)
	textInOrder(t, brief, "## What blocks the PR, in order", "## 1. Rebase on develop", "`git rebase origin/develop`",
		"`git push --force-with-lease`", "do not push, stop and ask the developer", "## 2. Failed remote checks", "- Backend (workflow CI)",
		"## 3. Local CI", "- local-e2e", "`molten ci run feature/9-fix-x`", "not trusted yet", "`needs you: the local CI commands need your approval`",
		"Never merge or approve the PR")
	for _, gone := range []string{"## 4.", "Test report", "Review round"} {
		if strings.Contains(brief, gone) {
			t.Errorf("a blocker the PR does not have: %q", gone)
		}
	}
	if strings.Contains(strings.ToLower(line), "gh pr merge") || strings.Contains(brief, "gh pr merge") {
		t.Error("the agent is never told to merge")
	}
}

// AC: only a failed local CI status (named after the local CI) → the brief targets the local CI alone.
func TestAnalyzeAndResolveLocalCiOnly(t *testing.T) {
	f := makeRestartFixture(t)
	f.agentOnBranch()
	req := f.investigateRequest(false)
	req.Checks = []InvestigateCheck{{Name: "AI testing / local CI"}}
	res, err := f.r.AskInvestigate(context.Background(), req)
	if err != nil || res.Status != RestartSent {
		t.Fatalf("result: %+v %v", res, err)
	}
	line := f.typed["agent-term"]
	if !strings.Contains(line, "1. local CI failed: AI testing / local CI (molten ci run)") || strings.Contains(line, "2.") {
		t.Errorf("prompt: %s", line)
	}
	brief := readText(t, res.BriefPath)
	if !strings.Contains(brief, "## 1. Local CI") || strings.Contains(brief, "Failed remote checks") || strings.Contains(brief, "Rebase on") {
		t.Errorf("brief:\n%s", brief)
	}
}

// The other blockers: no test report, an unanswered review round (its own brief, the round handed over), a local CI
// whose statuses are missing on the head.
func TestAnalyzeAndResolveReportRoundAndMissingLocalCi(t *testing.T) {
	f := makeRestartFixture(t)
	f.publishRound()
	f.agentOnBranch()
	f.write(f.dir, ".molten/project.json", `{"ci":{"jobs":[{"name":"unit","run":"true"}],"statuses":"github"}}`)
	req := f.investigateRequest(false)
	req.Checks, req.NoReport, req.ChangesRequested = nil, true, true
	res, err := f.r.AskInvestigate(context.Background(), req)
	if err != nil || res.Status != RestartSent || res.Round != "round-one-id" {
		t.Fatalf("result: %+v %v", res, err)
	}
	textInOrder(t, f.typed["agent-term"], "1. local CI not run on the head", "2. no test report", "3. review round 1 to answer")
	brief := readText(t, res.BriefPath)
	roundBrief := filepath.Join(f.dataDir, "molten", "reviews", RepoKey(f.k.Repo), restartDirName, "9-round-on.md")
	textInOrder(t, brief, "## 1. Local CI", "the head has none yet", "## 2. Test report", "`## Test report`", "## 3. Review round 1", roundBrief)
	if strings.Contains(brief, "Changes requested") {
		t.Error("the round covers the requested changes")
	}
	if !pathExists(roundBrief) {
		t.Fatalf("the round's own brief: %s", roundBrief)
	}
	if round := f.round(); round.RestartedAt == 0 || round.RestartBlockId != "agent-term" {
		t.Errorf("the round is handed over: %+v", round)
	}

	// Handed over, the round is no longer a blocker; the local CI statuses seen on the head are not missing.
	req.LocalSeen = true
	res, err = f.r.AskInvestigate(context.Background(), req)
	if err != nil || res.Status != RestartSent {
		t.Fatalf("result: %+v %v", res, err)
	}
	brief = readText(t, res.BriefPath)
	textInOrder(t, brief, "## 1. Test report", "## 2. Changes requested", "gh pr view 9 -R "+f.k.Repo+" --comments")
	if strings.Contains(brief, "Local CI") || strings.Contains(brief, "Review round") {
		t.Errorf("brief:\n%s", brief)
	}
}

func TestIsLocalCiCheck(t *testing.T) {
	for name, want := range map[string]bool{"local-e2e": true, "AI testing / local CI": true, "Local-CI": true, "Backend": false, "localize": false} {
		if IsLocalCiCheck(name) != want {
			t.Errorf("%q: %v", name, !want)
		}
	}
}

// AC: the required checks pass but a local CI status fails on the pushed head → never green, needs you with its name.
func TestInvestigationIsNotGreenWhileALocalStatusFails(t *testing.T) {
	f, follow, st, ci := investigateFollow(t)
	ci.checks = `[{"name":"Backend","bucket":"pass"}]`
	ci.allChecks = `[{"name":"Backend","bucket":"pass"},{"name":"local-e2e","bucket":"fail"}]`
	f.setAgent(molten.AgentStateDone, 10)
	f.r.followStep(context.Background(), follow, st)
	f.setAgent(molten.AgentStateDone, 11)
	if !f.r.followStep(context.Background(), follow, st) || len(ci.releases) != 0 {
		t.Fatalf("not green while local-e2e fails: %v", ci.releases)
	}
	if ci.lastHold() != "new-block waiting notif.review.localStillFailing" || len(f.notes) != 1 || f.notes[0].MessageText.Vars["names"] != "local-e2e" || f.notes[0].MessageText.Vars["branch"] != "feature/9-fix-x" {
		t.Fatalf("still failing on the head: %v %+v", ci.holds, f.notes)
	}
	ci.allChecks = `[{"name":"Backend","bucket":"pass"},{"name":"local-e2e","bucket":"pass"}]`
	f.setAgent(molten.AgentStateDone, 12)
	if f.r.followStep(context.Background(), follow, st) || len(ci.releases) != 1 {
		t.Fatalf("green once nothing fails: %v", ci.releases)
	}
}

// Regression (#1020, SaaSFoundryAI PR #1083): only local CI statuses fail. After the agent pushes, the new head has no
// local status yet and the gate check named after the local CI is red: MoltenTerm waits for the local CI there instead
// of calling it red, tells the developer when it never comes, and judges the statuses once they are posted.
func TestInvestigationWaitsForTheLocalCiOnThePushedHead(t *testing.T) {
	f, follow, st, ci := investigateFollow(t)
	now := time.UnixMilli(5000)
	f.r.env.Now = func() time.Time { return now }
	ci.checks = `[{"name":"Backend","bucket":"pass"}]`
	ci.allChecks = `[{"name":"Backend","bucket":"pass"},{"name":"AI testing / local CI","bucket":"fail"}]`
	for i := int64(10); i < 13; i++ {
		f.setAgent(molten.AgentStateDone, i)
		if !f.r.followStep(context.Background(), follow, st) {
			t.Fatal("the follow goes on")
		}
	}
	if ci.lastHold() != "new-block working agentHold.localCi" || len(f.notes) != 0 || len(ci.releases) != 0 {
		t.Fatalf("no local status on the head: waiting for the local CI, never red: %v %+v", ci.holds, f.notes)
	}
	now = now.Add(localCiWait + time.Minute)
	f.setAgent(molten.AgentStateDone, 13)
	f.r.followStep(context.Background(), follow, st)
	if ci.lastHold() != "new-block waiting notif.review.localCiMissing" || len(f.notes) != 1 || f.notes[0].MessageText.Vars["branch"] != "feature/9-fix-x" {
		t.Fatalf("the local CI never ran on the head: needs you, saying what to run: %v %+v", ci.holds, f.notes)
	}
	ci.allChecks = `[{"name":"Backend","bucket":"pass"},{"name":"AI testing / local CI","bucket":"pass"},{"name":"local-unit","bucket":"pass"}]`
	f.setAgent(molten.AgentStateDone, 14)
	if f.r.followStep(context.Background(), follow, st) || len(ci.releases) != 1 || ci.releases[0] != "new-block done agentHold.green" {
		t.Fatalf("the local CI posted green on the head: green: %v", ci.releases)
	}
}

// A project whose local CI posts statuses: green on GitHub alone is not green while the head has none.
func TestJudgeChecksWaitsForDeclaredLocalStatuses(t *testing.T) {
	pass := []ghCheckBucket{{Name: "Backend", Bucket: "pass"}}
	if v := judgeChecks(pass, pass, true); v.state != ciPending || !v.localWait {
		t.Errorf("declared, none posted: %+v", v)
	}
	if v := judgeChecks(pass, pass, false); v.state != ciPassed {
		t.Errorf("no local CI: %+v", v)
	}
	withLocal := append(append([]ghCheckBucket{}, pass...), ghCheckBucket{Name: "local-unit", Bucket: "fail"})
	if v := judgeChecks(pass, withLocal, true); v.state != ciFailed || v.failed[0] != "local-unit" {
		t.Errorf("posted and red: %+v", v)
	}
	remoteRed := []ghCheckBucket{{Name: "Backend", Bucket: "fail"}, {Name: "AI testing / local CI", Bucket: "fail"}}
	if v := judgeChecks(remoteRed, remoteRed, false); v.state != ciFailed {
		t.Errorf("a remote check fails, whatever the local CI: %+v", v)
	}
}

// A broken local CI (#1020): the brief tells the code's failure from the CI's, and the agent's outcome line for a wrong
// declaration or a MoltenTerm bug becomes a "needs you" saying so.
func TestBrokenLocalCiNeedsYouWithTheReason(t *testing.T) {
	f := makeRestartFixture(t)
	f.agentOnBranch()
	req := f.investigateRequest(false)
	req.Checks = []InvestigateCheck{{Name: "local-e2e", Local: true}}
	res, err := f.r.AskInvestigate(context.Background(), req)
	if err != nil || res.Status != RestartSent {
		t.Fatalf("result: %+v %v", res, err)
	}
	textInOrder(t, readText(t, res.BriefPath), "Tell a failure of the code from a broken local CI", "`molten ci run develop --only <job>`",
		"- The code:", "- The project's pipeline declaration (`.molten/project.json`)", "needs the developer's trust again",
		"`needs you: local CI declaration:", "- The environment:", "`needs you: environment:", "- MoltenTerm itself:",
		"statuses are not posted on the pushed head", "Do not loop", "`needs you: MoltenTerm bug:")

	for _, c := range []struct{ line, code, reason string }{
		{"needs you: local CI declaration: the e2e job ran from the wrong folder, fixed its cwd", "notif.review.ciDeclaration", "the e2e job ran from the wrong folder, fixed its cwd"},
		{"needs you: MoltenTerm bug: molten ci run feature/9-fix-x, statuses not posted on abc123, /data/ci/run-7/e2e.log", "notif.review.moltenBug", "molten ci run feature/9-fix-x, statuses not posted on abc123, /data/ci/run-7/e2e.log"},
		{"needs you: environment: port 5432 is used by another process", "notif.review.ciEnvironment", "port 5432 is used by another process"},
	} {
		f, follow, st, ci := investigateFollow(t)
		if err := os.WriteFile(follow.outcomePath, []byte(c.line+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
		f.setAgent(molten.AgentStateDone, 10)
		f.r.followStep(context.Background(), follow, st)
		if ci.lastHold() != "new-block waiting "+c.code || len(f.notes) != 1 || f.notes[0].MessageText.Code != c.code ||
			f.notes[0].MessageText.Vars["reason"] != c.reason || len(ci.calls) != 0 {
			t.Errorf("%s: %v %+v", c.code, ci.holds, f.notes)
		}
	}
}
