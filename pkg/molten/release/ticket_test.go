// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// The release's ticket (#1800): found in the version's milestone however many issues it holds, never made twice, made
// when the milestone holds none. The commit format of these projects names a ticket.

const ticketManifest = `{"workflow":{"commitFormat":{"pattern":"<type>(#<ticket>): <description>","requireTicket":true}}}`

func ticketFixture(t *testing.T) (*fixture, *Env, *Project) {
	t.Helper()
	f := makeFixture(t)
	writeFile(t, filepath.Join(f.checkout, ".saasfoundry.json"), ticketManifest)
	f.gh.milestones = `[{"number":12,"title":"v1.0.0","html_url":"https://m/12","open_issues":1}]`
	e := f.env()
	p, err := e.LoadProject(context.Background())
	mustRun(t, f, "load", err)
	if !p.Convention.TicketScope {
		t.Fatal("requireTicket makes the commits name the ticket")
	}
	return f, e, p
}

func issuesJson(t *testing.T, from int, count int, title string) string {
	t.Helper()
	issues := make([]map[string]any, 0, count)
	for i := 0; i < count; i++ {
		issues = append(issues, map[string]any{"number": from + i, "title": fmt.Sprintf("%s %d", title, from+i)})
	}
	data, err := json.Marshal(issues)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestReleaseTicketIsFoundInTheMilestone(t *testing.T) {
	serialTest(t, "sets MOLTEN_RELEASE_TICKET, which the release reads from the process environment")
	f, e, p := ticketFixture(t)
	f.gh.issues = `[{"number":41,"title":"A bug"},{"number":1078,"title":"Release v1.0.0"},{"number":7,"title":"Release v1.0.0","pull_request":{"url":"x"}}]`
	if n, err := e.releaseTicket(context.Background(), p, "1.0.0"); err != nil || n != 1078 {
		t.Fatalf("ticket %d, %v", n, err)
	}
	if calls := f.gh.called("issue", "create"); len(calls) != 0 {
		t.Fatalf("a ticket was created although the milestone holds it: %v", calls)
	}
	if !strings.Contains(f.out.String(), "Commits name #1078, the release ticket of milestone v1.0.0") {
		t.Fatalf("output:\n%s", f.out.String())
	}
	t.Setenv(TicketEnv, "#953")
	if n, _ := f.env().releaseTicket(context.Background(), p, "1.0.0"); n != 953 {
		t.Fatalf("MOLTEN_RELEASE_TICKET: %d", n)
	}
	other := f.env()
	other.Ticket = 77
	if n, _ := other.releaseTicket(context.Background(), p, "1.0.0"); n != 77 {
		t.Fatalf("--ticket: %d", n)
	}
}

// 825 issues were in milestone 1.0.0 when v1.0.0-7 stopped: the lookup read the first hundred.
func TestReleaseTicketIsFoundBeyondTheFirstHundredIssues(t *testing.T) {
	t.Parallel()
	f, e, p := ticketFixture(t)
	f.gh.issuePages = map[int]string{
		1: issuesJson(t, 1000, 100, "A story"),
		2: issuesJson(t, 900, 100, "A bug"),
		3: `[{"number":12,"title":"Rework the board"},{"number":1799,"title":"Release v1.0.0"}]`,
	}
	if n, err := e.releaseTicket(context.Background(), p, "1.0.0"); err != nil || n != 1799 {
		t.Fatalf("ticket %d, %v", n, err)
	}
	pages := 0
	for _, call := range f.gh.called("api") {
		if strings.Contains(strings.Join(call, " "), "issues?milestone=12&state=all") {
			pages++
		}
	}
	if pages != 3 {
		t.Fatalf("%d pages read, want 3", pages)
	}
	if calls := f.gh.called("issue", "create"); len(calls) != 0 {
		t.Fatalf("a second ticket was created: %v", calls)
	}
}

func TestReleaseTicketIsCreatedWhenTheMilestoneHoldsNone(t *testing.T) {
	t.Parallel()
	f, e, p := ticketFixture(t)
	f.gh.issuePages = map[int]string{1: `[{"number":41,"title":"A bug"}]`}
	n, err := e.releaseTicket(context.Background(), p, "1.0.0")
	if err != nil || n != 1801 {
		t.Fatalf("ticket %d, %v\n%s", n, err, f.out.String())
	}
	calls := f.gh.called("issue", "create")
	if len(calls) != 1 {
		t.Fatalf("issue create calls: %v", calls)
	}
	if got := strings.Join(calls[0], " "); !strings.Contains(got, "--title Release v1.0.0 ") || !strings.HasSuffix(got, "--milestone v1.0.0") {
		t.Fatalf("the ticket is not the release's, in its milestone: %s", got)
	}
	if !strings.Contains(f.out.String(), "Created #1801, the release ticket of milestone v1.0.0 (Release v1.0.0).") {
		t.Fatalf("output:\n%s", f.out.String())
	}
	// The same run answers the same ticket, without asking GitHub again.
	if again, err := e.releaseTicket(context.Background(), p, "1.0.0"); err != nil || again != 1801 {
		t.Fatalf("again %d, %v", again, err)
	}
	// Another run finds what the first one made.
	f.gh.issuePages = map[int]string{1: `[{"number":1801,"title":"Release v1.0.0"},{"number":41,"title":"A bug"}]`}
	if again, err := f.env().releaseTicket(context.Background(), p, "1.0.0"); err != nil || again != 1801 {
		t.Fatalf("another run %d, %v", again, err)
	}
	if calls := f.gh.called("issue", "create"); len(calls) != 1 {
		t.Fatalf("a second ticket was created: %v", calls)
	}
}

// A milestone holds hundreds of issues: only the release's own title is the release's ticket.
func TestReleaseTicketIsNeverAnotherTitle(t *testing.T) {
	t.Parallel()
	f, e, p := ticketFixture(t)
	f.gh.issuePages = map[int]string{1: `[
		{"number":10,"title":"Release v1.0.0-7"},
		{"number":11,"title":"Release notes for 1.0.0"},
		{"number":12,"title":"fix(release): v1.0.0 stops at the commit"},
		{"number":13,"title":"Release v1.0.01"},
		{"number":14,"title":"Release v1.0.0.1"},
		{"number":15,"title":"Release v1.0.0","pull_request":{"url":"x"}},
		{"number":16,"title":"Rollback of release v1.0.0 plan"}]`}
	if n, err := e.releaseTicket(context.Background(), p, "1.0.0"); err != nil || n != 1801 {
		t.Fatalf("ticket %d, %v", n, err)
	}
	for title, want := range map[string]bool{
		"Release v1.0.0":          true,
		"release v1.0.0":          true,
		"Release 1.0.0":           true,
		"  Release v1.0.0  ":      true,
		"Release v1.0.0 (public)": true,
		"Release v1.0.0: the cut": true,
		"Release v1.0.0-7":        false,
		"Release v1.0.01":         false,
		"Release v1.0.0.1":        false,
		"Release: v1.0.0":         false,
		"Prepare release v1.0.0":  false,
	} {
		if got := p.titlesRelease(title, "1.0.0"); got != want {
			t.Errorf("%q: %v, want %v", title, got, want)
		}
	}
	p.Rules.TagPrefix = "app-v"
	if !p.titlesRelease("Release app-v1.0.0", "1.0.0") || !p.titlesRelease("Release v1.0.0", "1.0.0") || p.ReleaseTicketTitle("1.0.0") != "Release app-v1.0.0" {
		t.Errorf("a project's tag prefix names its release ticket")
	}
}

func TestReleaseTicketIsNotCreatedWhereThereIsNowhereToCreateIt(t *testing.T) {
	t.Parallel()
	f, e, p := ticketFixture(t)
	f.github = false
	_, err := e.releaseTicket(context.Background(), p, "1.0.0")
	mustFail(t, f, "a repository that is not on GitHub", err, "pass --ticket N, or put an issue titled \"Release v1.0.0\" in the 1.0.0 milestone")

	f.github = true
	f.gh.milestones = `[{"number":3,"title":"Later","html_url":"https://m/3","open_issues":0}]`
	_, err = f.env().releaseTicket(context.Background(), p, "1.0.0")
	mustFail(t, f, "a version without a milestone", err, "pass --ticket N, or put an issue titled \"Release v1.0.0\" in the 1.0.0 milestone")
	if calls := f.gh.called("issue", "create"); len(calls) != 0 {
		t.Fatalf("a ticket was created: %v", calls)
	}
}

// Not finding the ticket because GitHub did not answer is no reason to make a second one.
func TestReleaseTicketIsNeverCreatedWhenTheLookupFails(t *testing.T) {
	t.Parallel()
	f, e, p := ticketFixture(t)
	f.gh.issuesFail = fmt.Errorf("gh: HTTP 502")
	_, err := e.releaseTicket(context.Background(), p, "1.0.0")
	mustFail(t, f, "an unreadable milestone", err, "pass --ticket N")
	f.gh.issuesFail = nil
	f.gh.issuePages = map[int]string{}
	for page := 1; page <= milestoneMaxPages; page++ {
		f.gh.issuePages[page] = issuesJson(t, page*1000, milestonePageSize, "An issue")
	}
	_, err = f.env().releaseTicket(context.Background(), p, "1.0.0")
	mustFail(t, f, "a milestone too large to read", err, "holds more than")
	if calls := f.gh.called("issue", "create"); len(calls) != 0 {
		t.Fatalf("a ticket was created without looking everywhere: %v", calls)
	}
	f.gh.issuePages, f.gh.createFails = nil, fmt.Errorf("gh: Resource not accessible by integration")
	f.gh.issues = `[]`
	_, err = f.env().releaseTicket(context.Background(), p, "1.0.0")
	mustFail(t, f, "a refused creation", err, "could not create the release ticket \"Release v1.0.0\"")
}

const ticketToolManifest = `{"workflow":{"tool":"github-projects","projectUrl":"https://github.com/orgs/Example/projects/1","commitFormat":{"pattern":"<type>(#<ticket>): <description>","requireTicket":true}},"tools":{"srs":{"backend":"notion"}}}`

// What the project's ticket CLI is given, one line, and the address it prints.
const fakeTicketTool = "#!/usr/bin/env bash\necho \"$@\" > '%s'\necho 'Issue URL: https://github.com/Example/app/issues/1802'\nexit %d\n"

func ticketToolFixture(t *testing.T, exit int) (*fixture, *Env, *Project, string) {
	t.Helper()
	f := makeFixture(t)
	rel := ".claude/skills/sf-tool-github-projects/github-projects-cli.sh"
	// The log's path is written into the script: an environment variable would keep every test of this fixture from
	// running in parallel.
	log := filepath.Join(f.base, "ticket-tool.log")
	writeFile(t, filepath.Join(f.checkout, ".saasfoundry.json"), ticketToolManifest)
	writeFile(t, filepath.Join(f.checkout, rel), fmt.Sprintf(fakeTicketTool, log, exit))
	gitIn(t, f.checkout, "add", "-A")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "chore(#2): the ticket tool")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	// The working copy's tool is not the reviewed one: never run.
	writeFile(t, filepath.Join(f.checkout, rel), "#!/usr/bin/env bash\necho 'Issue URL: https://github.com/Example/app/issues/99'\n")
	f.gh.milestones = `[{"number":12,"title":"1.0.0","html_url":"https://m/12","open_issues":0}]`
	f.gh.issues = `[]`
	e := f.env()
	p, err := e.LoadProject(context.Background())
	mustRun(t, f, "load", err)
	return f, e, p, log
}

func TestReleaseTicketGoesThroughTheProjectsTicketTool(t *testing.T) {
	t.Parallel()
	f, e, p, log := ticketToolFixture(t, 0)
	mustRun(t, f, "fetch", e.fetch(context.Background(), p.Root))
	n, err := e.releaseTicket(context.Background(), p, "1.0.0")
	if err != nil || n != 1802 {
		t.Fatalf("ticket %d, %v\n%s", n, err, f.out.String())
	}
	args := strings.TrimSpace(readFile(t, log))
	if !strings.HasPrefix(args, "create-ticket task Release v1.0.0 --body-file ") ||
		!strings.HasSuffix(args, " --complexity low --nature internal --milestone 1.0.0 --bypass-srs release-ticket") {
		t.Fatalf("tool arguments: %s", args)
	}
	if calls := f.gh.called("issue", "create"); len(calls) != 0 {
		t.Fatalf("a plain issue was made too: %v", calls)
	}
	if calls := f.gh.called("api", "--method", "PATCH"); len(calls) != 0 {
		t.Fatalf("a finished ticket is not patched: %v", calls)
	}
}

// The tool made the issue and failed on a later step: the ticket is the one to use, and it must be in its milestone, or
// the next run would look for it there and make another.
func TestReleaseTicketKeepsWhatTheTicketToolStartedAndPutsItInItsMilestone(t *testing.T) {
	t.Parallel()
	f, e, p, _ := ticketToolFixture(t, 1)
	mustRun(t, f, "fetch", e.fetch(context.Background(), p.Root))
	n, err := e.releaseTicket(context.Background(), p, "1.0.0")
	if err != nil || n != 1802 {
		t.Fatalf("ticket %d, %v\n%s", n, err, f.out.String())
	}
	patches := f.gh.called("api", "--method", "PATCH")
	if len(patches) != 1 || !strings.Contains(strings.Join(patches[0], " "), "issues/1802 -F milestone=12") {
		t.Fatalf("patches: %v", patches)
	}
	if calls := f.gh.called("issue", "create"); len(calls) != 0 {
		t.Fatalf("a second ticket was made: %v", calls)
	}
}

// The working copy still holds a tool (#99 if it ran), but the trunk and the release branch do not: a plain issue.
func TestReleaseTicketFallsBackToAnIssueWithoutTheToolOnTheTrunk(t *testing.T) {
	t.Parallel()
	f, e, p, _ := ticketToolFixture(t, 0)
	gitIn(t, f.checkout, "rm", "--quiet", "-f", "--cached", ".claude/skills/sf-tool-github-projects/github-projects-cli.sh")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "chore(#3): drop the tool")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	mustRun(t, f, "fetch", e.fetch(context.Background(), p.Root))
	if n, err := e.releaseTicket(context.Background(), p, "1.0.0"); err != nil || n != 1801 {
		t.Fatalf("ticket %d, %v\n%s", n, err, f.out.String())
	}
}
