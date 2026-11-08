// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package pipelinesetup

import (
	"context"
	"strings"
	"sync"
	"testing"
)

// The setup's pull request follows the project's workflow (#1788): a draft only for a Human Testing route, the
// ticket it creates through the project's ticket tool.

const humanTestingManifest = `{
  "version": "1.0.4",
  "workflow": {
    "tool": "github-projects",
    "projectUrl": "https://github.com/orgs/DiamondForgeFr/projects/5",
    "workingBranch": "develop",
    "prTargetBranch": "develop",
    "releaseBranch": "master",
    "branchNaming": { "feature": "feature/{N}-{description}", "fix": "fix/{N}-{description}", "release": "rc-{version}" },
    "commitFormat": { "pattern": "<type>(#<ticket>): <description>", "requireTicket": true },
    "statuses": [ { "name": "Backlog" }, { "name": "In Progress" }, { "name": "AI Testing" }, { "name": "Human  testing" },
      { "name": "In Review" }, { "name": "Done" } ]
  }
}
`

// The tool proves it got the setup's body, then prints the address of the issue it made and fails a later step
// (the board, say): the ticket exists, it is the one to use.
const ticketToolScript = `#!/usr/bin/env bash
grep -q "release pipeline" "$5" || exit 3
echo "Creating task..."
echo "Issue URL: https://github.com/DiamondForgeFr/SaasFoundryAI/issues/12"
exit 1
`

// commitProject commits files on develop and pushes them to origin, as a merged pull request would.
func commitProject(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	writeFiles(t, dir, files)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore(#3): the workflow")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")
}

type draftCall struct {
	dir    string
	number int
	url    string
	target string
}

func watchedSetup(t *testing.T, forge *fakeForge) (*Setup, func() []draftCall) {
	s := prSetup(t, forge, protectedRules(t))
	var lock sync.Mutex
	var calls []draftCall
	s.OnDraftPr = func(dir string, number int, url string, target string) {
		lock.Lock()
		defer lock.Unlock()
		calls = append(calls, draftCall{dir, number, url, target})
	}
	return s, func() []draftCall {
		lock.Lock()
		defer lock.Unlock()
		return append([]draftCall{}, calls...)
	}
}

func writeSetup(t *testing.T, s *Setup, dir string, req PrRequest) PrJob {
	t.Helper()
	draft, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	job := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Generated: draft.Generated, PrRequest: req}))
	if job.Failure != nil {
		t.Fatalf("failure: %+v", job.Failure)
	}
	return job
}

func prArgs(t *testing.T, forge *fakeForge) string {
	t.Helper()
	prs, _ := forge.calls()
	if len(prs) != 1 {
		t.Fatalf("prs: %v", prs)
	}
	return strings.Join(prs[0], " ")
}

func TestWorkflowHasHumanTesting(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if WorkflowHasHumanTesting(dir) {
		t.Fatal("no manifest, no Human Testing")
	}
	writeFiles(t, dir, map[string]string{".saasfoundry.json": sfManifest})
	if WorkflowHasHumanTesting(dir) {
		t.Fatal("no statuses, no Human Testing")
	}
	writeFiles(t, dir, map[string]string{".saasfoundry.json": humanTestingManifest})
	if !WorkflowHasHumanTesting(dir) {
		t.Fatal("the status is named, spaces and case aside")
	}
}

func TestAHumanTestingTicketGetsADraftThatIsFollowed(t *testing.T) {
	t.Parallel()
	dir := protectedRepository(t)
	commitProject(t, dir, map[string]string{".saasfoundry.json": humanTestingManifest})
	forge := &fakeForge{}
	s, draftCalls := watchedSetup(t, forge)
	job := writeSetup(t, s, dir, PrRequest{Ticket: 7})
	if args := prArgs(t, forge); !strings.Contains(args, "pr create --draft --base develop") {
		t.Fatalf("gh %s", args)
	}
	if !job.Draft {
		t.Fatalf("job: %+v", job)
	}
	calls := draftCalls()
	if len(calls) != 1 || calls[0].dir != dir || calls[0].number != 42 || calls[0].target != "develop" ||
		calls[0].url != "https://github.com/DiamondForgeFr/SaasFoundryAI/pull/42" {
		t.Fatalf("followed: %+v", calls)
	}
}

func TestAnInternalTicketSkipsHumanTesting(t *testing.T) {
	t.Parallel()
	dir := protectedRepository(t)
	commitProject(t, dir, map[string]string{".saasfoundry.json": humanTestingManifest})
	forge := &fakeForge{labels: `{"labels":[{"name":"complexity: low"},{"name":"Nature:Internal"}]}`}
	s, draftCalls := watchedSetup(t, forge)
	job := writeSetup(t, s, dir, PrRequest{Ticket: 7})
	if args := prArgs(t, forge); strings.Contains(args, "--draft") || job.Draft {
		t.Fatalf("gh %s, job %+v", args, job)
	}
	if calls := draftCalls(); len(calls) != 0 {
		t.Fatalf("a ready pull request is not followed: %+v", calls)
	}
}

func TestTheTicketGoesThroughTheProjectsTicketTool(t *testing.T) {
	t.Parallel()
	dir := protectedRepository(t)
	commitProject(t, dir, map[string]string{
		".saasfoundry.json": humanTestingManifest,
		".claude/skills/sf-tool-github-projects/github-projects-cli.sh": ticketToolScript,
	})
	// The working copy's tool is not the project's reviewed one: never run.
	writeFiles(t, dir, map[string]string{".claude/skills/sf-tool-github-projects/github-projects-cli.sh": strings.ReplaceAll(ticketToolScript, "/12", "/99")})
	forge := &fakeForge{issueNum: "9"}
	s, draftCalls := watchedSetup(t, forge)
	job := writeSetup(t, s, dir, PrRequest{CreateTicket: true})
	if job.Ticket != 12 || job.Branch != "feature/12-release-pipeline" {
		t.Fatalf("job: %+v", job)
	}
	if _, issues := forge.calls(); len(issues) != 0 {
		t.Fatalf("a plain issue was made too: %v", issues)
	}
	tools := forge.toolCalls()
	if len(tools) != 1 {
		t.Fatalf("tool: %v", tools)
	}
	args := strings.Join(tools[0][1:], " ")
	if !strings.HasPrefix(args, "create-ticket task Declare the release pipeline --body-file ") ||
		!strings.HasSuffix(args, " --complexity low --nature internal") || strings.HasPrefix(tools[0][0], dir) {
		t.Fatalf("tool %v", tools[0])
	}
	// The ticket it made is nature:internal: no Human Testing, the pull request is ready for review.
	if pr := prArgs(t, forge); strings.Contains(pr, "--draft") || !strings.Contains(pr, "Resolves #12") || job.Draft || len(draftCalls()) != 0 {
		t.Fatalf("gh %s, job %+v", pr, job)
	}
}

func TestATicketToolThatMakesNothingFallsBackToAnIssue(t *testing.T) {
	t.Parallel()
	dir := protectedRepository(t)
	commitProject(t, dir, map[string]string{
		".saasfoundry.json": strings.Replace(humanTestingManifest, `"version": "1.0.4",`, `"version": "1.0.4", "tools": { "srs": { "backend": "notion" } },`, 1),
		".agents/skills/sf-tool-github-projects/github-projects-cli.sh": "#!/usr/bin/env bash\necho \"$@\" >&2\nexit 2\n",
	})
	forge := &fakeForge{issueNum: "9"}
	s, draftCalls := watchedSetup(t, forge)
	job := writeSetup(t, s, dir, PrRequest{CreateTicket: true})
	if job.Ticket != 9 {
		t.Fatalf("job: %+v", job)
	}
	tools := forge.toolCalls()
	if len(tools) != 1 || !strings.HasSuffix(strings.Join(tools[0], " "), "--nature internal --bypass-srs release-setup") {
		t.Fatalf("tool: %v", tools)
	}
	if _, issues := forge.calls(); len(issues) != 1 {
		t.Fatalf("issues: %v", issues)
	}
	// A plain issue carries no nature: the Human Testing route keeps the draft.
	if pr := prArgs(t, forge); !strings.Contains(pr, "--draft") || !job.Draft || len(draftCalls()) != 1 {
		t.Fatalf("gh %s, job %+v", pr, job)
	}
}

func TestPrReadyRunsGhOnTheAddress(t *testing.T) {
	t.Parallel()
	var got [][]string
	s := &Setup{Run: func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		got = append(got, append([]string{dir, name}, args...))
		return nil, nil
	}}
	dir := t.TempDir()
	for _, bad := range []string{"", "--repo=x", "https://github.com/o/r/issues/3", "https://github.com/o/r/pull/3 --x"} {
		if _, err := s.PrReady(context.Background(), PrReadyRequest{Dir: dir, Url: bad}); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	if _, err := s.PrReady(context.Background(), PrReadyRequest{Dir: "relative", Url: "https://github.com/o/r/pull/3"}); err == nil {
		t.Fatal("a relative folder accepted")
	}
	answer, err := s.PrReady(context.Background(), PrReadyRequest{Dir: dir, Url: "https://github.com/o/r/pull/3"})
	if err != nil || !answer.Ready {
		t.Fatalf("%v %+v", err, answer)
	}
	if len(got) != 1 || strings.Join(got[0][1:], " ") != "gh pr ready https://github.com/o/r/pull/3" {
		t.Fatalf("calls: %v", got)
	}
}
