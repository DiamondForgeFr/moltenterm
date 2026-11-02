// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func (f *restartFixture) releaseRequest(mode string) ReleaseResolveRequest {
	return ReleaseResolveRequest{Dir: f.dir, Repo: restartRepo, Tag: "v1.0.0-5", Phase: "prepare", Step: "Promote develop",
		Trunk: "develop", Log: "GitHub CI on develop 65542e1:\n  waiting for ci.yml…\nci.yml failed on develop 65542e1 https://github.com/acme/app/actions/runs/389: fix develop first\n",
		Runs: []InvestigateCheck{{Name: "ci.yml", Url: "https://github.com/acme/app/actions/runs/389", RunId: 389}},
		Mode: mode, WorkspaceId: "ws-1", TabName: "Release v1.0.0-5"}
}

// releaseGh: the developer's gh as a fake; it gives the failed log and refuses everything that could change GitHub.
func (f *restartFixture) releaseGh(calls *[]string) {
	f.r.env.Gh = func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		call := strings.Join(args, " ")
		*calls = append(*calls, call)
		if call != "run view 389 --log-failed -R "+restartRepo {
			return nil, fmt.Errorf("MoltenTerm must not %s", call)
		}
		return []byte("Perf budgets\tnpm ci\tnpm ERR! network ECONNRESET\n"), nil
	}
}

// #945: Analyze and resolve starts the agent out of sight, in a new copy of the trunk, with the release rules.
func TestAskReleaseResolveStartsTheAgentOutOfSight(t *testing.T) {
	f := makeRestartFixture(t)
	var calls []string
	f.releaseGh(&calls)
	res, err := f.r.AskReleaseResolve(context.Background(), f.releaseRequest(AgentModeBackground))
	if err != nil || res.Status != RestartStarted || res.BlockId != "new-block" || !res.Hidden || res.Agent != molten.AgentIdClaude {
		t.Fatalf("result: %+v %v", res, err)
	}
	if len(f.tabs) != 1 || !f.tabs[0].hidden || f.tabs[0].name != "Release v1.0.0-5" || f.tabs[0].workspaceId != "ws-1" {
		t.Errorf("one hidden tab in the workspace, got %+v", f.tabs)
	}
	if len(f.opened) != 1 {
		t.Fatalf("only the agent's terminal opens out of sight, got %v", f.opened)
	}
	want := filepath.Join(f.dataDir, "molten", "worktrees")
	if !strings.HasPrefix(res.Worktree, want) || !strings.HasPrefix(filepath.Base(res.Worktree), "release-v1.0.0-5") {
		t.Errorf("worktree %s, want release-v1.0.0-5 under %s", res.Worktree, want)
	}
	if head := f.git(res.Worktree, "rev-parse", "--abbrev-ref", "HEAD"); head != "HEAD" {
		t.Errorf("the copy must be detached, it is on %s", head)
	}
	if main := f.git(f.dir, "rev-parse", "--abbrev-ref", "HEAD"); main != "develop" {
		t.Errorf("the main checkout moved to %s", main)
	}
	command := f.opened[0]
	for _, part := range []string{"claude -- ", "release v1.0.0-5 failed at Promote develop", "rerun the failed jobs when the code is not the cause",
		"PR into develop", "Never push develop or main, never merge, tag, publish or run the release", res.BriefPath} {
		if !strings.Contains(command, part) {
			t.Errorf("the prompt misses %q: %s", part, command)
		}
	}
	origin, _ := f.openMeta[OriginMetaKey].(AgentOrigin)
	if origin.Kind != AgentOriginRelease || origin.Tag != "v1.0.0-5" || origin.Phase != "prepare" || origin.Step != "Promote develop" {
		t.Errorf("origin %+v", origin)
	}
	if f.openMeta[waveobj.MetaKey_CmdCwd] != res.Worktree {
		t.Errorf("the agent works in its copy: %v", f.openMeta)
	}
	brief := readText(t, res.BriefPath)
	logPath := strings.TrimSuffix(res.BriefPath, ".md") + ".log"
	outcome := strings.TrimSuffix(res.BriefPath, ".md") + ".outcome"
	for _, part := range []string{"# Resolve the failed release step: v1.0.0-5, Promote develop", "Analyze and resolve",
		"- ci.yml: https://github.com/acme/app/actions/runs/389", "gh run rerun 389 --failed -R " + restartRepo,
		"Never push to develop, main or a release branch, never merge a pull request", "never create, move or push a tag",
		"never publish or edit a GitHub release", "never run `molten release`", "Never touch the project's main checkout or another worktree",
		"open a pull request into develop. Do not merge it.", logPath, "write one line in the developer's language to " + outcome, "`needs you:`"} {
		if !strings.Contains(brief, part) {
			t.Errorf("the brief misses %q:\n%s", part, brief)
		}
	}
	logText := readText(t, logPath)
	for _, part := range []string{"ci.yml failed on develop 65542e1", "failed jobs of run 389", "ECONNRESET"} {
		if !strings.Contains(logText, part) {
			t.Errorf("the log misses %q:\n%s", part, logText)
		}
	}
	if len(calls) != 1 {
		t.Errorf("gh only reads the failed log: %v", calls)
	}
}

// #945: Investigate together shows the tab, with the failing logs beside the agent.
func TestAskReleaseResolveTogetherOpensTheLogsBesideTheAgent(t *testing.T) {
	f := makeRestartFixture(t)
	var calls []string
	f.releaseGh(&calls)
	res, err := f.r.AskReleaseResolve(context.Background(), f.releaseRequest(AgentModeTogether))
	if err != nil || res.Status != RestartStarted || res.Hidden || res.TabId != "agent-tab" {
		t.Fatalf("result: %+v %v", res, err)
	}
	if len(f.tabs) != 1 || f.tabs[0].hidden {
		t.Errorf("one shown tab, got %+v", f.tabs)
	}
	if len(f.opened) != 2 || !strings.HasPrefix(f.opened[1], "less -R +G ") || !strings.Contains(f.opened[1], ".log") {
		t.Fatalf("the agent, then its logs: %v", f.opened)
	}
	if !strings.Contains(f.opened[0], "The developer is with you") {
		t.Errorf("the prompt says the developer is there: %s", f.opened[0])
	}
	if !strings.Contains(readText(t, res.BriefPath), "Investigate together") {
		t.Errorf("the brief says why it opened")
	}
}

func TestAskReleaseResolveChecksTheRequest(t *testing.T) {
	f := makeRestartFixture(t)
	for name, change := range map[string]func(*ReleaseResolveRequest){
		"phase":     func(r *ReleaseResolveRequest) { r.Phase = "deploy" },
		"tag":       func(r *ReleaseResolveRequest) { r.Tag = "-x" },
		"trunk":     func(r *ReleaseResolveRequest) { r.Trunk = "" },
		"step":      func(r *ReleaseResolveRequest) { r.Step = " " },
		"mode":      func(r *ReleaseResolveRequest) { r.Mode = "" },
		"workspace": func(r *ReleaseResolveRequest) { r.WorkspaceId = "" },
		"repo":      func(r *ReleaseResolveRequest) { r.Repo = "../x" },
		"run":       func(r *ReleaseResolveRequest) { r.Runs = []InvestigateCheck{{Name: "", RunId: 1}} },
	} {
		req := f.releaseRequest(AgentModeBackground)
		change(&req)
		if _, err := f.r.AskReleaseResolve(context.Background(), req); err == nil {
			t.Errorf("%s: a bad request was accepted", name)
		}
	}
	if len(f.opened) != 0 || len(f.tabs) != 0 {
		t.Errorf("nothing may start: %v %v", f.opened, f.tabs)
	}
	l := &routeLink{service: &Service{}}
	if _, err := callAs(l, "proc:block-1", ReleaseResolveCommand, map[string]any{}); err == nil {
		t.Errorf("a terminal must not start a release agent")
	}
}

func TestAskReleaseResolveWithoutAnAgent(t *testing.T) {
	f := makeRestartFixture(t)
	f.installed = map[string]bool{}
	res, err := f.r.AskReleaseResolve(context.Background(), f.releaseRequest(AgentModeBackground))
	if err != nil || res.Status != RestartNoAgent {
		t.Fatalf("result: %+v %v", res, err)
	}
	if len(f.opened) != 0 || len(f.tabs) != 0 || res.Worktree != "" {
		t.Errorf("nothing may start: %v %v %s", f.opened, f.tabs, res.Worktree)
	}
}

// #945: once the agent stops, its outcome line reaches the developer; its copy goes with its terminal when clean.
func TestReleaseFollowReportsTheOutcomeAndCleansUp(t *testing.T) {
	f := makeRestartFixture(t)
	var calls []string
	f.releaseGh(&calls)
	res, err := f.r.AskReleaseResolve(context.Background(), f.releaseRequest(AgentModeBackground))
	if err != nil || res.Status != RestartStarted {
		t.Fatalf("result: %+v %v", res, err)
	}
	follow := agentFollow{req: f.releaseRequest(AgentModeBackground).restartRequest(), tree: res.Worktree, created: true,
		blockId: "new-block", tabId: "agent-tab", agent: molten.AgentIdClaude, outcomePath: investigateOutcomePath(res.BriefPath),
		origin: AgentOrigin{Kind: AgentOriginRelease, Tag: "v1.0.0-5", Phase: "prepare", Step: "Promote develop", Mode: AgentModeBackground}}
	st := &followState{}
	f.runs["new-block"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateWorking}
	if !f.r.followStep(context.Background(), follow, st) || len(f.notes) != 0 {
		t.Fatalf("nothing is told while it works: %+v", f.notes)
	}
	f.runs["new-block"] = molten.AgentRunInfo{Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, StateSince: 2}
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 1 || f.notes[0].Kind != "warning" || f.notes[0].MessageText.Code != "notif.release.silent" {
		t.Fatalf("a stop without an outcome out of sight is told: %+v", f.notes)
	}
	if err := os.WriteFile(follow.outcomePath, []byte("reran Perf budgets, green: retry the step\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.r.followStep(context.Background(), follow, st)
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 2 || f.notes[1].Kind != "success" || f.notes[1].TitleText.Code != "notif.release.doneTitle" ||
		!strings.Contains(f.notes[1].Message, "retry the step") {
		t.Fatalf("the outcome is told once: %+v", f.notes)
	}
	if err := os.WriteFile(follow.outcomePath, []byte("needs you: the fix changes the product\n"), 0600); err != nil {
		t.Fatal(err)
	}
	f.r.followStep(context.Background(), follow, st)
	if len(f.notes) != 3 || f.notes[2].Kind != "warning" || f.notes[2].TitleText.Code != "notif.release.needsTitle" {
		t.Fatalf("a decision is a warning: %+v", f.notes)
	}
	f.gone["new-block"] = true
	if f.r.followStep(context.Background(), follow, st) {
		t.Error("the follow ends with the terminal")
	}
	if pathExists(res.Worktree) {
		t.Errorf("the clean copy must go with the terminal: %s", res.Worktree)
	}
	if main := f.git(f.dir, "rev-parse", "--abbrev-ref", "HEAD"); main != "develop" {
		t.Errorf("the main checkout moved to %s", main)
	}
}

func TestReleaseFollowKeepsACopyWithWork(t *testing.T) {
	f := makeRestartFixture(t)
	var calls []string
	f.releaseGh(&calls)
	res, err := f.r.AskReleaseResolve(context.Background(), f.releaseRequest(AgentModeTogether))
	if err != nil || res.Status != RestartStarted {
		t.Fatalf("result: %+v %v", res, err)
	}
	f.write(res.Worktree, "fix.txt", "half done\n")
	follow := agentFollow{req: f.releaseRequest(AgentModeTogether).restartRequest(), tree: res.Worktree, created: true,
		blockId: "new-block", origin: AgentOrigin{Kind: AgentOriginRelease, Tag: "v1.0.0-5", Mode: AgentModeTogether}}
	f.gone["new-block"] = true
	f.r.followStep(context.Background(), follow, &followState{})
	if !pathExists(filepath.Join(res.Worktree, "fix.txt")) {
		t.Error("a copy with work left in it must stay")
	}
}
