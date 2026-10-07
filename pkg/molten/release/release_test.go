// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The chain runs against a throwaway project whose origin is a bare repository in the test's temporary folder: no
// tag, branch or release can reach a real remote. gh is a fake that records what it was asked.

const fixtureProject = `{
    "schema": 1,
    "name": "Fixture",
    "branches": { "trunk": "develop", "release": "main" },
    "versions": {
        "tagprefix": "v",
        "notes": "releases/{tag}.md",
        "firstpublic": "1.0.0",
        "files": [
            { "path": "package.json", "format": "json", "keys": [["version"]] },
            { "path": "package-lock.json", "format": "json", "keys": [["version"], ["packages", "", "version"]] }
        ]
    }
}
`

type fakeGh struct {
	lock      sync.Mutex
	calls     [][]string
	ciRuns    map[string]string
	dispatch  func()
	draft     bool
	noRelease bool
	issues    string
	prs       string
}

func (f *fakeGh) record(args []string) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.calls = append(f.calls, args)
}

func (f *fakeGh) called(prefix ...string) [][]string {
	f.lock.Lock()
	defer f.lock.Unlock()
	var rtn [][]string
	for _, call := range f.calls {
		if len(call) >= len(prefix) && strings.Join(call[:len(prefix)], " ") == strings.Join(prefix, " ") {
			rtn = append(rtn, call)
		}
	}
	return rtn
}

func (f *fakeGh) answer(args []string) ([]byte, error) {
	f.record(args)
	joined := strings.Join(args, " ")
	switch {
	case strings.HasPrefix(joined, "run list"):
		state := f.ciRuns[args[3]]
		switch state {
		case "green":
			return []byte(`[{"status":"completed","conclusion":"success","url":"https://ci/1"}]`), nil
		case "red":
			return []byte(`[{"status":"completed","conclusion":"failure","url":"https://ci/2"}]`), nil
		case "running":
			return []byte(`[{"status":"in_progress","conclusion":"","url":"https://ci/3"}]`), nil
		}
		return []byte(`[]`), nil
	case strings.HasPrefix(joined, "workflow run"):
		if f.dispatch != nil {
			f.dispatch()
		}
		return nil, nil
	case strings.HasPrefix(joined, "pr list"):
		if f.prs == "" {
			return []byte(`[]`), nil
		}
		return []byte(f.prs), nil
	case strings.HasPrefix(joined, "pr create"):
		return []byte("https://github.example/pr/9\n"), nil
	case strings.HasPrefix(joined, "release view"):
		if f.noRelease {
			return nil, fmt.Errorf("gh release view: release not found")
		}
		return []byte(fmt.Sprintf(`{"isDraft":%v,"url":"https://github.example/releases/%s"}`, f.draft, args[2])), nil
	case strings.HasPrefix(joined, "api repos/{owner}/{repo}/milestones?"):
		return []byte(`[{"number":7,"title":"Later","html_url":"https://m/7","open_issues":4},{"number":12,"title":"1.0.0","html_url":"https://m/12","open_issues":2}]`), nil
	case strings.HasPrefix(joined, "api repos/{owner}/{repo}/issues?milestone=12"):
		if f.issues != "" {
			return []byte(f.issues), nil
		}
		return []byte(`[{"number":41,"title":"An open bug","html_url":"https://i/41"},{"number":42,"title":"A pull request","html_url":"https://i/42","pull_request":{"url":"x"}}]`), nil
	case strings.HasPrefix(joined, "api --method PATCH"):
		return []byte(`{}`), nil
	}
	return nil, fmt.Errorf("fake gh: unexpected %s", joined)
}

type fixture struct {
	base     string
	checkout string
	origin   string
	gh       *fakeGh
	github   bool
	out      *bytes.Buffer
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeFile(t *testing.T, path string, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func makeFixture(t *testing.T) *fixture {
	t.Helper()
	// Nothing of the developer's git configuration (signing, hooks, aliases) may change what the chain does.
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Release test")
	t.Setenv("GIT_AUTHOR_EMAIL", "release@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Release test")
	t.Setenv("GIT_COMMITTER_EMAIL", "release@example.invalid")
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{base: base, checkout: filepath.Join(base, "app"), origin: filepath.Join(base, "origin.git"), out: &bytes.Buffer{}, github: true}
	f.gh = &fakeGh{ciRuns: map[string]string{"ci.yml": "green"}}
	gitIn(t, base, "init", "--quiet", "--bare", "-b", "develop", f.origin)
	gitIn(t, base, "init", "--quiet", "-b", "develop", f.checkout)
	gitIn(t, f.checkout, "remote", "add", "origin", f.origin)
	writeFile(t, filepath.Join(f.checkout, ".molten", "project.json"), fixtureProject)
	writeFile(t, filepath.Join(f.checkout, "package.json"), "{\n    \"name\": \"fixture\",\n    \"version\": \"1.0.0-0\"\n}\n")
	writeFile(t, filepath.Join(f.checkout, "package-lock.json"), "{\n  \"name\": \"fixture\",\n  \"version\": \"1.0.0-0\",\n  \"packages\": {\n    \"\": {\n      \"version\": \"1.0.0-0\"\n    }\n  }\n}\n")
	writeFile(t, filepath.Join(f.checkout, "app.txt"), "one\n")
	gitIn(t, f.checkout, "add", "-A")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "chore(#1): bootstrap")
	gitIn(t, f.checkout, "push", "--quiet", "-u", "origin", "develop")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop:main")
	return f
}

func (f *fixture) env() *Env {
	return &Env{
		Dir: f.checkout,
		Run: func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
			if name == "gh" {
				return f.gh.answer(args)
			}
			return ExecRunner(ctx, dir, name, args...)
		},
		Out:      f.out,
		IsGithub: func(ctx context.Context) bool { return f.github },
		Sleep:    func(time.Duration) {},
		CiPoll:   time.Millisecond,
	}
}

// commitOnDevelop adds a commit to develop on origin, as a merged pull request would.
func (f *fixture) commitOnDevelop(t *testing.T, subject string) {
	t.Helper()
	gitIn(t, f.checkout, "fetch", "--quiet", "origin")
	gitIn(t, f.checkout, "checkout", "--quiet", "-B", "develop", "origin/develop")
	path := filepath.Join(f.checkout, "app.txt")
	writeFile(t, path, readFile(t, path)+subject+"\n")
	gitIn(t, f.checkout, "commit", "--quiet", "-am", subject)
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
}

func (f *fixture) originRef(t *testing.T, ref string) string {
	t.Helper()
	return gitIn(t, f.origin, "rev-parse", ref)
}

func (f *fixture) originFile(t *testing.T, ref string, path string) string {
	t.Helper()
	return gitIn(t, f.origin, "show", ref+":"+path)
}

func (f *fixture) worktree() string {
	return f.checkout + ReleaseWorktreeSuffix
}

func mustRun(t *testing.T, f *fixture, what string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v\n--- output ---\n%s", what, err, f.out.String())
	}
}

func mustFail(t *testing.T, f *fixture, what string, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s succeeded, want a refusal containing %q\n--- output ---\n%s", what, want, f.out.String())
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("%s: %v, want it to contain %q", what, err, want)
	}
}

func cutRelease(t *testing.T, f *fixture, tag string) {
	t.Helper()
	ctx := context.Background()
	e := f.env()
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustRun(t, f, "prepare "+tag, e.Prepare(ctx, tag))
	mustRun(t, f, "finalize "+tag, e.Finalize(ctx, tag))
}

func TestReleaseChainEndToEnd(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	e := f.env()
	f.commitOnDevelop(t, "feat(#2): a second feature")
	f.commitOnDevelop(t, "fix(#3): a crash on start (#3)")

	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	if f.originRef(t, "main") != f.originRef(t, "develop") {
		t.Fatalf("main was not fast-forwarded onto develop")
	}

	f.out.Reset()
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	notesPath := filepath.Join(f.worktree(), "releases", "v1.0.0-1.md")
	if !strings.Contains(f.out.String(), NotesMarker+notesPath) {
		t.Fatalf("prepare did not announce the notes:\n%s", f.out.String())
	}
	notes := readFile(t, notesPath)
	for _, want := range []string{"## New", "- A second feature", "## Fixes", "- A crash on start"} {
		if !strings.Contains(notes, want) {
			t.Fatalf("notes lack %q:\n%s", want, notes)
		}
	}
	if strings.Contains(notes, "#3") || strings.Contains(notes, "bootstrap") {
		t.Fatalf("notes carry a ticket number or a chore:\n%s", notes)
	}
	if got := readFile(t, filepath.Join(f.worktree(), "package-lock.json")); strings.Count(got, "1.0.0-1") != 2 {
		t.Fatalf("package-lock.json not bumped at both places:\n%s", got)
	}
	if gitIn(t, f.checkout, "status", "--porcelain") != "" {
		t.Fatalf("the checkout was touched by prepare")
	}

	writeFile(t, notesPath, notes+"\nEdited before the cut.\n")
	mustRun(t, f, "finalize", e.Finalize(ctx, "v1.0.0-1"))
	if f.originRef(t, "v1.0.0-1") != f.originRef(t, "main") {
		t.Fatalf("the tag is not main's tip on origin")
	}
	if msg := gitIn(t, f.origin, "log", "-1", "--format=%s", "main"); msg != "chore(release): v1.0.0-1 (rc)" {
		t.Fatalf("release commit %q", msg)
	}
	if !strings.Contains(f.originFile(t, "v1.0.0-1", "releases/v1.0.0-1.md"), "Edited before the cut.") {
		t.Fatalf("the edited notes were not committed")
	}
	if !strings.Contains(f.originFile(t, "v1.0.0-1", "package.json"), `"version": "1.0.0-1"`) {
		t.Fatalf("package.json not bumped in the release commit")
	}

	// develop moved on while the release was cut.
	f.commitOnDevelop(t, "fix(#4): a fix merged during the release")
	mustRun(t, f, "sync-back", e.SyncBack(ctx, "v1.0.0-1"))
	creates := f.gh.called("pr", "create")
	if len(creates) != 1 || !strings.Contains(strings.Join(creates[0], " "), "--base develop --head chore/sync-back-v1.0.0-1") {
		t.Fatalf("sync-back pull request: %v", creates)
	}
	// The pull request is merged.
	gitIn(t, f.checkout, "fetch", "--quiet", "origin")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "origin/chore/sync-back-v1.0.0-1:refs/heads/develop")
	f.out.Reset()
	mustRun(t, f, "sync-back again", e.SyncBack(ctx, "v1.0.0-1"))
	if !strings.Contains(f.out.String(), "nothing to carry back") || len(f.gh.called("pr", "create")) != 1 {
		t.Fatalf("a second sync-back did something:\n%s", f.out.String())
	}

	mustRun(t, f, "close-milestone of an rc", e.CloseMilestone(ctx, "v1.0.0-1"))
	if len(f.gh.called("api", "--method", "PATCH")) != 0 {
		t.Fatalf("a release candidate closed the milestone")
	}

	// The next promotion is a merge commit: main holds the release commit, develop its cherry-pick.
	f.commitOnDevelop(t, "feat(#5): a third feature")
	mustRun(t, f, "promote with a merge", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	if parent := gitIn(t, f.origin, "rev-parse", "main^2"); parent != f.originRef(t, "develop") {
		t.Fatalf("main is not a merge of develop: second parent %s", parent)
	}
	if gitIn(t, f.origin, "diff", "main", "develop") != "" {
		t.Fatalf("main's tree differs from develop's after the promotion")
	}

	f.out.Reset()
	mustRun(t, f, "prepare public", e.Prepare(ctx, "v1.0.0"))
	public := readFile(t, filepath.Join(f.worktree(), "releases", "v1.0.0.md"))
	for _, want := range []string{"A second feature", "A third feature"} {
		if !strings.Contains(public, want) {
			t.Fatalf("public notes start from the last public release, they lack %q:\n%s", want, public)
		}
	}
	mustRun(t, f, "finalize public", e.Finalize(ctx, "v1.0.0"))
	if msg := gitIn(t, f.origin, "log", "-1", "--format=%s", "v1.0.0"); msg != "chore(release): v1.0.0 (public)" {
		t.Fatalf("public release commit %q", msg)
	}

	f.gh.draft = true
	mustFail(t, f, "close-milestone of a draft", e.CloseMilestone(ctx, "v1.0.0"), "still a draft")
	f.gh.draft = false
	f.out.Reset()
	mustRun(t, f, "close-milestone", e.CloseMilestone(ctx, "v1.0.0"))
	patches := f.gh.called("api", "--method", "PATCH")
	if len(patches) != 1 || patches[0][3] != "repos/{owner}/{repo}/milestones/12" {
		t.Fatalf("milestone close: %v", patches)
	}
	if !strings.Contains(f.out.String(), "#41 An open bug") || strings.Contains(f.out.String(), "A pull request") {
		t.Fatalf("the open issues were not reported as a warning:\n%s", f.out.String())
	}
}

func TestPromoteRefusesWhatTheTrunkLacks(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	f.commitOnDevelop(t, "feat(#2): a feature")
	cutRelease(t, f, "v1.0.0-1")
	// No sync-back: develop lacks the release commit.
	f.commitOnDevelop(t, "feat(#3): another feature")
	before := f.originRef(t, "main")
	mustFail(t, f, "promote", f.env().Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}), "not carried back")
	if f.originRef(t, "main") != before {
		t.Fatalf("main moved although the promotion was refused")
	}
}

func TestPromoteRequiresGreenCi(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	f.commitOnDevelop(t, "feat(#2): a feature")
	before := f.originRef(t, "main")

	mustFail(t, f, "promote without workflows", f.env().Promote(ctx, PromoteOptions{}), "--workflow")
	f.gh.ciRuns["ci.yml"] = "red"
	mustFail(t, f, "promote on red", f.env().Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}), "failed on develop")
	if f.originRef(t, "main") != before {
		t.Fatalf("main moved on a red CI")
	}

	f.gh.ciRuns["ci.yml"] = ""
	f.gh.dispatch = func() { f.gh.ciRuns["ci.yml"] = "green" }
	mustRun(t, f, "promote on a missing run", f.env().Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	if len(f.gh.called("workflow", "run", "ci.yml", "--ref", "develop")) != 1 {
		t.Fatalf("the missing run was not started once: %v", f.gh.calls)
	}
	if f.originRef(t, "main") != f.originRef(t, "develop") {
		t.Fatalf("main was not promoted once CI turned green")
	}
}

func TestPromoteDryRunAndOffGithub(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	f.commitOnDevelop(t, "feat(#2): a feature")
	before := f.originRef(t, "main")
	f.gh.ciRuns["ci.yml"] = "running"
	f.gh.dispatch = nil
	e := f.env()
	e.CiLimit = time.Nanosecond
	mustFail(t, f, "promote while CI runs past the limit", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}), "still not done")
	f.gh.ciRuns["ci.yml"] = ""
	mustRun(t, f, "dry run", f.env().Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}, DryRun: true}))
	if f.originRef(t, "main") != before || len(f.gh.called("workflow", "run")) != 0 {
		t.Fatalf("a dry run pushed or started something")
	}
	f.github = false
	mustRun(t, f, "promote off GitHub", f.env().Promote(ctx, PromoteOptions{}))
	if f.originRef(t, "main") != f.originRef(t, "develop") {
		t.Fatalf("main was not promoted off GitHub")
	}
}

func TestPrepareRefusesWrongNumbers(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	e := f.env()
	f.commitOnDevelop(t, "feat(#2): a feature")
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustFail(t, f, "a skipped candidate", e.Prepare(ctx, "v1.0.0-2"), "next release candidate of 1.0.0 is v1.0.0-1")
	mustFail(t, f, "not a release", e.Prepare(ctx, "v1.0.0-0"), "not a release tag")
	mustFail(t, f, "below firstpublic", e.Prepare(ctx, "v0.9.0"), "not a release tag")
	mustFail(t, f, "an injected tag", e.Prepare(ctx, "v1.0.0-1;rm"), "not a release tag")
	mustRun(t, f, "finalize first", func() error {
		if err := e.Prepare(ctx, "v1.0.0-1"); err != nil {
			return err
		}
		return e.Finalize(ctx, "v1.0.0-1")
	}())
	mustFail(t, f, "a taken tag", e.Prepare(ctx, "v1.0.0-1"), "already exists")
	gitIn(t, f.checkout, "fetch", "--quiet", "origin")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "origin/main:refs/heads/develop")
	mustRun(t, f, "public", func() error {
		if err := e.Prepare(ctx, "v1.0.0"); err != nil {
			return err
		}
		return e.Finalize(ctx, "v1.0.0")
	}())
	mustFail(t, f, "a candidate of a released version", e.Prepare(ctx, "v1.0.0-2"), "already released")
	mustFail(t, f, "a public release not above the last", e.Prepare(ctx, "v1.0.0"), "already exists")
}

func TestFinalizeChecksThePreparedTree(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	e := f.env()
	f.commitOnDevelop(t, "feat(#2): a feature")
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustFail(t, f, "finalize before prepare", e.Finalize(ctx, "v1.0.0-1"), "prepare v1.0.0-1 first")

	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	writeFile(t, filepath.Join(f.worktree(), "stray.txt"), "left over\n")
	mustFail(t, f, "a stray file", e.Finalize(ctx, "v1.0.0-1"), "stray.txt")

	mustRun(t, f, "prepare again", e.Prepare(ctx, "v1.0.0-1"))
	if _, err := os.Stat(filepath.Join(f.worktree(), "stray.txt")); err == nil {
		t.Fatalf("prepare did not reset the worktree")
	}
	writeFile(t, filepath.Join(f.worktree(), "releases", "v1.0.0-1.md"), "  \n")
	mustFail(t, f, "empty notes", e.Finalize(ctx, "v1.0.0-1"), "missing or empty")

	mustRun(t, f, "prepare again", e.Prepare(ctx, "v1.0.0-1"))
	writeFile(t, filepath.Join(f.worktree(), "package.json"), "{\n    \"name\": \"fixture\",\n    \"version\": \"1.0.0-7\"\n}\n")
	mustFail(t, f, "a changed version", e.Finalize(ctx, "v1.0.0-1"), "reads 1.0.0-7")

	mustRun(t, f, "prepare again", e.Prepare(ctx, "v1.0.0-1"))
	gitIn(t, f.checkout, "fetch", "--quiet", "origin")
	gitIn(t, f.checkout, "checkout", "--quiet", "-B", "hotfix", "origin/main")
	writeFile(t, filepath.Join(f.checkout, "hotfix.txt"), "x\n")
	gitIn(t, f.checkout, "add", "hotfix.txt")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "fix(#5): hotfix")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "hotfix:main")
	mustFail(t, f, "main moved", e.Finalize(ctx, "v1.0.0-1"), "moved since the preparation")
	if f.tagOnOrigin(t, "v1.0.0-1") {
		t.Fatalf("a refused finalize pushed the tag")
	}
}

func (f *fixture) tagOnOrigin(t *testing.T, tag string) bool {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "--verify", "--quiet", "refs/tags/"+tag)
	cmd.Dir = f.origin
	return cmd.Run() == nil
}

func TestFinalizeRetriesAfterARefusedPush(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	e := f.env()
	f.commitOnDevelop(t, "feat(#2): a feature")
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	hook := filepath.Join(f.origin, "hooks", "pre-receive")
	writeFile(t, hook, "#!/bin/sh\necho 'refused by the test' >&2\nexit 1\n")
	if err := os.Chmod(hook, 0755); err != nil {
		t.Fatal(err)
	}
	mustFail(t, f, "finalize on a refusing origin", e.Finalize(ctx, "v1.0.0-1"), "push was refused")
	if f.tagOnOrigin(t, "v1.0.0-1") {
		t.Fatalf("the tag reached origin")
	}
	if out := gitIn(t, f.worktree(), "tag", "--list", "v1.0.0-1"); out != "" {
		t.Fatalf("the local tag was left behind")
	}
	if !strings.Contains(readFile(t, filepath.Join(f.worktree(), "package.json")), "1.0.0-1") {
		t.Fatalf("the prepared bump was lost")
	}
	os.Remove(hook)
	mustRun(t, f, "finalize again", e.Finalize(ctx, "v1.0.0-1"))
	if !f.tagOnOrigin(t, "v1.0.0-1") {
		t.Fatalf("the retry did not push the tag")
	}
}

func TestSyncBackReusesAnOpenPullRequest(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	f.commitOnDevelop(t, "feat(#2): a feature")
	cutRelease(t, f, "v1.0.0-1")
	f.gh.prs = `[{"url":"https://github.example/pr/8"}]`
	f.out.Reset()
	mustRun(t, f, "sync-back", f.env().SyncBack(ctx, "v1.0.0-1"))
	if len(f.gh.called("pr", "create")) != 0 || !strings.Contains(f.out.String(), "pr/8") {
		t.Fatalf("an open pull request was not reused:\n%s", f.out.String())
	}
	mustFail(t, f, "sync-back of an unpushed tag", f.env().SyncBack(ctx, "v1.0.0-2"), "not on origin")
}

func TestCloseMilestoneWithoutRelease(t *testing.T) {
	f := makeFixture(t)
	f.gh.noRelease = true
	mustFail(t, f, "close-milestone", f.env().CloseMilestone(context.Background(), "v1.0.0"), "no GitHub release")
}

func TestPlanReportsTheMilestone(t *testing.T) {
	f := makeFixture(t)
	f.commitOnDevelop(t, "feat(#2): a feature")
	reports, err := f.env().Plan(context.Background(), []string{"rc", "public"}, "")
	mustRun(t, f, "plan", err)
	if reports[0].Tag != "v1.0.0-1" || reports[1].Tag != "v1.0.0" {
		t.Fatalf("plan tags: %+v", reports)
	}
	m := reports[0].Milestone
	if m == nil || m.Title != "1.0.0" || len(m.Issues) != 1 || m.Issues[0].Number != 41 {
		t.Fatalf("plan milestone: %+v", m)
	}
	data, _ := json.Marshal(reports[0])
	if !strings.Contains(string(data), `"tag":"v1.0.0-1"`) || !strings.Contains(string(data), `"milestone":{`) {
		t.Fatalf("plan json: %s", data)
	}
}

func TestReleaseWorktreeIsBesideTheMainCheckout(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	other := filepath.Join(f.base, "elsewhere", "task")
	gitIn(t, f.checkout, "worktree", "add", "--quiet", "--detach", other)
	e := f.env()
	e.Dir = other
	wt, err := e.ReleaseWorktree(ctx, other)
	mustRun(t, f, "release worktree", err)
	if wt != f.worktree() {
		t.Fatalf("release worktree %s, want %s", wt, f.worktree())
	}
}

func TestLockRefusesASecondStep(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	e := f.env()
	unlock, err := e.lock(ctx, f.checkout)
	mustRun(t, f, "lock", err)
	mustFail(t, f, "second lock", func() error { _, err := e.lock(ctx, f.checkout); return err }(), "already running")
	unlock()
	common := gitIn(t, f.checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")
	writeFile(t, filepath.Join(common, lockDirName, "release.lock"), "999999999\n")
	unlock, err = e.lock(ctx, f.checkout)
	mustRun(t, f, "take over a stale lock", err)
	unlock()
}
