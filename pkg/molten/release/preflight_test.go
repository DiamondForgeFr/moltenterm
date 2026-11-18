// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The preflight (#2365): the checks a project declares in release.preflight run before any command that creates a tag.
// v1.0.0-12 was pushed by finalize, then the Electron freshness rule of release.yml refused it, and the tag had to be
// deleted. The checks here read flag files of the test, so nothing waits on a network or a clock: a check passes when
// its file exists, and fails the way the project's scripts do (a message, an ::error annotation) when it does not.

func flagCheck(base string, id string, title string, flag string, failure string, fix string) map[string]string {
	return map[string]string{
		"id":    id,
		"title": title,
		"run":   "test -f '" + filepath.Join(base, flag) + "' || { " + failure + "; exit 1; }",
		"fix":   fix,
	}
}

// What electron-staleness.mjs prints under --enforce: its report, which advises an exception, then one annotation per
// finding. It is a file so that the command the report echoes does not hold the words.
const electronReport = `## Electron engine: 45.2.3 needs an update
4. When a bump cannot ship in time, record a human-reviewed, dated exception in electronExceptions.
::error title=Electron engine::Electron 45.3.0 is out (Chromium 142)
`

func preflightChecks(t *testing.T, base string) []map[string]string {
	t.Helper()
	writeFile(t, filepath.Join(base, "electron.report"), electronReport)
	return []map[string]string{
		flagCheck(base, "scan", "Dependency scan", "scan.ok", "echo 'the scan found an advisory' >&2", "Fix the dependency on develop, then promote and prepare again."),
		flagCheck(base, "electron", "Electron engine freshness", "electron.ok", "cat '"+filepath.Join(base, "electron.report")+"'",
			"Bump Electron as security/ELECTRON.md says, merge it on develop, then promote and prepare again."),
	}
}

// declarePreflight commits the project's release.preflight on develop and main, before the release starts.
func declarePreflight(t *testing.T, f *fixture, checks []map[string]string) {
	t.Helper()
	var project map[string]any
	if err := json.Unmarshal([]byte(fixtureProject), &project); err != nil {
		t.Fatal(err)
	}
	project["release"] = map[string]any{"preflight": checks}
	data, err := json.MarshalIndent(project, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.checkout, ".molten", "project.json"), string(data)+"\n")
	gitIn(t, f.checkout, "commit", "--quiet", "-am", "chore(#9): declare the preflight checks")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop:main")
}

func pass(t *testing.T, f *fixture, flags ...string) {
	t.Helper()
	for _, flag := range flags {
		writeFile(t, filepath.Join(f.base, flag), "ok\n")
	}
}

// nothingTagged: no tag on origin or in the release worktree, the release branch where it was, the prepared tree still
// uncommitted.
func nothingTagged(t *testing.T, f *fixture, tag string, mainBefore string) {
	t.Helper()
	if f.tagOnOrigin(t, tag) {
		t.Fatalf("the refused release pushed %s", tag)
	}
	if tags := gitIn(t, f.worktree(), "tag", "--list", tag); tags != "" {
		t.Fatalf("the refused release left the tag %s in the release worktree", tag)
	}
	if got := f.originRef(t, "main"); got != mainBefore {
		t.Fatalf("the refused release moved main: %s, was %s", got, mainBefore)
	}
	if subject := gitIn(t, f.worktree(), "log", "-1", "--format=%s"); strings.HasPrefix(subject, "chore(release)") {
		t.Fatalf("the refused release left its release commit: %s", subject)
	}
}

func preparedRelease(t *testing.T, f *fixture, tag string) {
	t.Helper()
	ctx := context.Background()
	f.commitOnDevelop(t, "feat(#2): a feature")
	mustRun(t, f, "promote", f.env().Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustRun(t, f, "prepare "+tag, f.env().Prepare(ctx, tag))
}

func TestFinalizeRefusesBeforeTheTagWhenAPreflightCheckFails(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	ctx := context.Background()
	declarePreflight(t, f, preflightChecks(t, f.base))
	preparedRelease(t, f, "v1.0.0-1")
	mainBefore := f.originRef(t, "main")

	f.out.Reset()
	err := f.env().Finalize(ctx, "v1.0.0-1")
	mustFail(t, f, "finalize with failing checks", err, "v1.0.0-1 is not ready, nothing was committed")
	for _, want := range []string{
		`preflight check "Dependency scan" failed: the scan found an advisory`,
		"To fix: Fix the dependency on develop, then promote and prepare again.",
		`preflight check "Electron engine freshness" failed: Electron 45.3.0 is out (Chromium 142)`,
		"To fix: Bump Electron as security/ELECTRON.md says",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal lacks %q: %v", want, err)
		}
	}
	nothingTagged(t, f, "v1.0.0-1", mainBefore)
	// The report names each failure, and only the findings of the check: its own advice is the project's fix.
	if report := f.out.String(); !strings.Contains(report, "| Electron 45.3.0 is out (Chromium 142)") || !strings.Contains(report, "problem  preflight check") {
		t.Fatalf("the report does not list the findings:\n%s", report)
	}
	if strings.Contains(strings.ToLower(f.out.String()+err.Error()), "exception") {
		t.Fatalf("a refused preflight offered an exception:\n%s\n%v", f.out.String(), err)
	}

	// One check fixed, one left: still refused, naming only the one left.
	pass(t, f, "scan.ok")
	err = f.env().Finalize(ctx, "v1.0.0-1")
	mustFail(t, f, "finalize with one failing check", err, "Electron engine freshness")
	if strings.Contains(err.Error(), "Dependency scan") {
		t.Fatalf("the check that passes is named as a problem: %v", err)
	}
	nothingTagged(t, f, "v1.0.0-1", mainBefore)

	// Both pass: finalize behaves as it always did, on the same prepared tree.
	pass(t, f, "electron.ok")
	f.out.Reset()
	mustRun(t, f, "finalize with green checks", f.env().Finalize(ctx, "v1.0.0-1"))
	if !strings.Contains(f.out.String(), "Dependency scan passed") || !strings.Contains(f.out.String(), "Electron engine freshness passed") {
		t.Fatalf("the report does not say what passed:\n%s", f.out.String())
	}
	if f.originRef(t, "v1.0.0-1") != f.originRef(t, "main") {
		t.Fatalf("the tag is not main's tip on origin")
	}
	if msg := gitIn(t, f.origin, "log", "-1", "--format=%s", "main"); msg != "chore(release): v1.0.0-1 (rc)" {
		t.Fatalf("release commit %q", msg)
	}
}

func TestAProjectDeclaringNoCheckIsCutAsBefore(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	f.commitOnDevelop(t, "feat(#2): a feature")
	cutRelease(t, f, "v1.0.0-1")
	if strings.Contains(strings.ToLower(f.out.String()), "preflight") || strings.Contains(f.out.String(), "before anything is tagged") {
		t.Fatalf("a project that declares no check hears of the preflight:\n%s", f.out.String())
	}
	if !f.tagOnOrigin(t, "v1.0.0-1") {
		t.Fatal("the release was not tagged")
	}
}

func TestPreflightIsListedWithTheOtherProblemsOfTheRelease(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	ctx := context.Background()
	declarePreflight(t, f, preflightChecks(t, f.base)[:1])
	preparedRelease(t, f, "v1.0.0-1")
	mainBefore := f.originRef(t, "main")
	writeFile(t, filepath.Join(f.worktree(), "stray.txt"), "left over\n")

	err := f.env().Finalize(ctx, "v1.0.0-1")
	mustFail(t, f, "finalize", err, "v1.0.0-1 is not ready, nothing was committed")
	for _, want := range []string{"stray.txt", `preflight check "Dependency scan" failed`} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal lacks %q: %v", want, err)
		}
	}
	if f.tagOnOrigin(t, "v1.0.0-1") || f.originRef(t, "main") != mainBefore {
		t.Fatal("a refused finalize reached origin")
	}
}

// A release whose branch moved is prepared again, and the checks would read a tree that is not the release's.
func TestPreflightDoesNotRunOnATreeThatIsNotTheReleases(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	ctx := context.Background()
	marker := filepath.Join(f.base, "ran")
	declarePreflight(t, f, []map[string]string{{"id": "scan", "title": "Scan", "run": "touch '" + marker + "'"}})
	preparedRelease(t, f, "v1.0.0-1")
	gitIn(t, f.checkout, "fetch", "--quiet", "origin")
	gitIn(t, f.checkout, "checkout", "--quiet", "-B", "hotfix", "origin/main")
	writeFile(t, filepath.Join(f.checkout, "hotfix.txt"), "x\n")
	gitIn(t, f.checkout, "add", "hotfix.txt")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "fix(#5): hotfix")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "hotfix:main")

	mustFail(t, f, "finalize after main moved", f.env().Finalize(ctx, "v1.0.0-1"), "moved since the preparation")
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a check ran on a tree that is not the release's")
	}
}

// A check that cannot run is a failure: a read that did not happen is never a pass.
func TestAPreflightCheckThatCannotRunRefusesTheRelease(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	declarePreflight(t, f, []map[string]string{{"id": "ghost", "title": "Ghost", "run": "definitely-not-a-command-2365"}})
	preparedRelease(t, f, "v1.0.0-1")
	mainBefore := f.originRef(t, "main")

	err := f.env().Finalize(context.Background(), "v1.0.0-1")
	mustFail(t, f, "finalize", err, `preflight check "Ghost" failed: `)
	if !strings.Contains(err.Error(), "definitely-not-a-command-2365") {
		t.Fatalf("the refusal does not say what could not run: %v", err)
	}
	nothingTagged(t, f, "v1.0.0-1", mainBefore)
}

// A check runs in its own folder of the release worktree, with the release's variables.
func TestPreflightChecksRunInTheReleaseWorktreeWithTheVariables(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	probe := filepath.Join(f.base, "probe")
	declarePreflight(t, f, []map[string]string{
		{
			"id":    "where",
			"title": "Where",
			"run":   "test -f project.json && test '{tag}' = 'v1.0.0-1' && test '{version}' = '1.0.0-1' && test '{branch}' = 'main' && pwd -P > '" + probe + "'",
			"cwd":   ".molten",
		},
	})
	preparedRelease(t, f, "v1.0.0-1")
	mustRun(t, f, "finalize", f.env().Finalize(context.Background(), "v1.0.0-1"))
	got, err := os.ReadFile(probe)
	if err != nil {
		t.Fatalf("the check did not pass: %v\n%s", err, f.out.String())
	}
	if want := filepath.Join(f.worktree(), ".molten"); strings.TrimSpace(string(got)) != want {
		t.Fatalf("the check ran in %q, want %q", strings.TrimSpace(string(got)), want)
	}
}

// The commands of the pull-request flow that put a tag on origin run the checks too: a candidate that nothing
// publishes, and the tag on the merge commit of the release's pull request.
func TestTheOtherCommandsThatTagRunThePreflightToo(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	ctx := context.Background()
	writeFile(t, filepath.Join(f.checkout, ".saasfoundry.json"), `{"workflow":{"branchNaming":{"release":"rc-{version}"}}}`)
	gitIn(t, f.checkout, "add", ".saasfoundry.json")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "chore(#4): the harness")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	declarePreflight(t, f, preflightChecks(t, f.base)[:1])
	gh := &fakePrGitHub{t: t, f: f, checks: []string{"pass"}, state: "CLEAN"}
	e := f.env()
	e.Run = gh.run
	mainBefore := f.originRef(t, "main")

	mustRun(t, f, "prepare --pr the candidate", e.PreparePr(ctx, "v1.0.0-1"))
	mustFail(t, f, "tag --rc-branch", e.TagRcBranch(ctx, "v1.0.0-1"), `preflight check "Dependency scan" failed`)
	nothingTagged(t, f, "v1.0.0-1", mainBefore)
	if branch := gitIn(t, f.origin, "branch", "--list", "rc-1.0.0"); branch != "" {
		t.Fatalf("the refused candidate pushed its branch: %s", branch)
	}
	pass(t, f, "scan.ok")
	mustRun(t, f, "tag --rc-branch with a green check", e.TagRcBranch(ctx, "v1.0.0-1"))
	if f.originRef(t, "v1.0.0-1^{commit}") != f.originRef(t, "rc-1.0.0") {
		t.Fatal("the candidate's tag is not on its RC branch's head")
	}

	// The public release goes through its pull request: open-pr and merge-pr tag nothing, tag does.
	if err := os.Remove(filepath.Join(f.base, "scan.ok")); err != nil {
		t.Fatal(err)
	}
	f.commitOnDevelop(t, "feat(#8): a second feature")
	mustRun(t, f, "prepare --pr the public release", e.PreparePr(ctx, "v1.0.0"))
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
	mustRun(t, f, "merge-pr", e.MergePr(ctx, "v1.0.0", MergePrOptions{}))
	mustFail(t, f, "tag after the merge", e.Tag(ctx, "v1.0.0"), `preflight check "Dependency scan" failed`)
	if f.tagOnOrigin(t, "v1.0.0") {
		t.Fatal("the refused tag reached origin")
	}
	if local := gitIn(t, f.checkout, "tag", "--list", "v1.0.0"); local != "" {
		t.Fatalf("the refused tag was left locally: %s", local)
	}
	pass(t, f, "scan.ok")
	mustRun(t, f, "tag with a green check", e.Tag(ctx, "v1.0.0"))
	if !f.tagOnOrigin(t, "v1.0.0") {
		t.Fatal("the release was not tagged")
	}
}

// MoltenTerm's own declaration: the two checks the release of v1.0.0-12 lacked, which the project's scripts back.
func TestMoltenTermDeclaresItsPreflight(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	report := molten.ValidatePipeline(root)
	if !report.Valid {
		t.Fatalf("the project's pipeline is not valid: %v", report.Errors)
	}
	if report.Pipeline.Release == nil {
		t.Fatal("the project declares no release")
	}
	checks := report.Pipeline.Release.Preflight
	byId := map[string]molten.PipelineCheck{}
	for _, check := range checks {
		byId[check.Id] = check
	}
	scan, staleness := byId["dependency-scan"], byId["electron-freshness"]
	if !strings.Contains(scan.Run, "node scripts/security/scan.mjs") || !strings.Contains(scan.Fix, "security/TRIAGE.md") {
		t.Fatalf("the dependency scan is not declared as release.yml runs it: %+v", scan)
	}
	if !strings.Contains(staleness.Run, "node scripts/security/electron-staleness.mjs --enforce") || !strings.Contains(staleness.Fix, "security/ELECTRON.md") {
		t.Fatalf("the Electron freshness rule is not declared as release.yml runs it: %+v", staleness)
	}
	for _, check := range checks {
		if strings.Contains(strings.ToLower(check.Fix), "exception") {
			t.Fatalf("%s offers an exception, which only the developer approves: %q", check.Id, check.Fix)
		}
	}
}
