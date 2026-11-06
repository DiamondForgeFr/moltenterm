// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/ghguard"
)

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func commit(t *testing.T, dir string, file string, subject string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(subject), 0644); err != nil {
		t.Fatal(err)
	}
	gitRun(t, dir, "add", file)
	gitRun(t, dir, "commit", "-q", "-m", subject)
}

// plainRunner runs git and any other local program for real, and never gh (#1857): a test that needs gh answers it
// with withoutGh or a fake of its own. The refusal is recorded, so the run fails even when the code under test
// swallows the error.
func plainRunner(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name == "gh" {
		return nil, ghguard.Refuse(dir, args)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return out, errors.New(name + " failed")
	}
	return out, nil
}

// testCollector makes a collector whose background refreshes end before the test's temp folders go: a refresh still
// runs git in the project and writes the cache after Get returns (#1874). Make the project and the cache folder before
// calling it, so its cleanup runs before theirs.
func testCollector(t *testing.T, cacheDir string, run Runner, publish func(Snapshot)) *Collector {
	t.Helper()
	c := MakeCollector(cacheDir, run, publish)
	t.Cleanup(func() { waitRefreshesIdle(t, c) })
	return c
}

func waitRefreshesIdle(t *testing.T, c *Collector) {
	t.Helper()
	// Generous: it only bounds a failing run, a passing one returns as soon as the refreshes end.
	deadline := time.Now().Add(time.Minute)
	for c.refreshesInFlight() > 0 {
		if time.Now().After(deadline) {
			t.Errorf("collector refreshes still going a minute after the test: %d", c.refreshesInFlight())
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A git-flow project: main holds the releases, develop the work, one feature branch and tags v1.0.0, v1.1.0-1.
func makeGitFlowRepo(t *testing.T) string {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q", "-b", "main")
	commit(t, dir, "a.txt", "feat(#1): first")
	gitRun(t, dir, "tag", "v1.0.0")
	gitRun(t, dir, "checkout", "-q", "-b", "develop")
	commit(t, dir, "b.txt", "feat(#2): second")
	commit(t, dir, "c.txt", "fix(#3): third")
	gitRun(t, dir, "tag", "-a", "v1.1.0-1", "-m", "rc")
	gitRun(t, dir, "checkout", "-q", "-b", "feature/4-thing")
	commit(t, dir, "d.txt", "feat(#4): thing")
	gitRun(t, dir, "checkout", "-q", "develop")
	os.MkdirAll(filepath.Join(dir, "releases"), 0755)
	os.WriteFile(filepath.Join(dir, "releases", "v1.0.0.md"), []byte("First release"), 0644)
	return dir
}

func TestCollectGitFlow(t *testing.T) {
	t.Parallel()
	dir := makeGitFlowRepo(t)
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Trunk != "develop" || snap.Release != "main" || snap.Current != "develop" {
		t.Fatalf("branches: trunk %q release %q current %q", snap.Trunk, snap.Release, snap.Current)
	}
	names := []string{}
	for _, b := range snap.Branches {
		names = append(names, b.Name)
	}
	if strings.Join(names, ",") != "main,develop,feature/4-thing" {
		t.Fatalf("branch order: %v", names)
	}
	feature := snap.Branches[2]
	if feature.Fork == nil || len(feature.Commits) != 1 || feature.Commits[0].Subject != "feat(#4): thing" {
		t.Fatalf("feature branch: %+v", feature)
	}
	if len(snap.Branches[1].Commits) != 3 {
		t.Fatalf("develop first-parent history: %+v", snap.Branches[1].Commits)
	}
	if snap.LastPublic != "v1.0.0" {
		t.Fatalf("last public: %q", snap.LastPublic)
	}
	if len(snap.SincePublic) != 2 || len(snap.Ahead) != 2 {
		t.Fatalf("since public %d, ahead %d", len(snap.SincePublic), len(snap.Ahead))
	}
	tags := map[string]Tag{}
	for _, tag := range snap.Tags {
		tags[tag.Name] = tag
	}
	if tags["v1.0.0"].Notes != "First release" || tags["v1.1.0-1"].Sha != snap.Branches[1].Sha {
		t.Fatalf("tags: %+v", snap.Tags)
	}
}

// Without a public release, a remote or a tag, the trunk's whole history waits for the first public release (#745).
func TestCollectGitSincePublicBeforeFirstRelease(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q", "-b", "main")
	commit(t, dir, "a.txt", "feat: first")
	commit(t, dir, "b.txt", "feat: second")
	commit(t, dir, "c.txt", "fix: third")
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Trunk != "main" || snap.Release != "main" || snap.LastPublic != "" || snap.RemoteUrl != "" {
		t.Fatalf("trunk %q release %q last public %q remote %q", snap.Trunk, snap.Release, snap.LastPublic, snap.RemoteUrl)
	}
	subjects := []string{}
	for _, c := range snap.SincePublic {
		subjects = append(subjects, c.Subject)
	}
	if strings.Join(subjects, ",") != "fix: third,feat: second,feat: first" {
		t.Fatalf("since public, newest first: %v", subjects)
	}
}

func TestCollectGitReadsConfiguredBranches(t *testing.T) {
	t.Parallel()
	dir := makeGitFlowRepo(t)
	os.WriteFile(filepath.Join(dir, ".saasfoundry.json"), []byte(`{"mainBranch":"main","workflow":{"workingBranch":"feature/4-thing"}}`), 0644)
	snap, err := CollectGit(context.Background(), plainRunner, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Trunk != "feature/4-thing" {
		t.Fatalf("trunk from .saasfoundry.json: %q", snap.Trunk)
	}
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"branches":{"trunk":"develop"}}`), 0644)
	if got := ConfiguredBranches(dir); got.Trunk != "develop" || got.Release != "main" {
		t.Fatalf("pipeline file first: %+v", got)
	}
}

func TestCollectGitNotARepository(t *testing.T) {
	t.Parallel()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	if _, err := CollectGit(context.Background(), plainRunner, t.TempDir(), false); err == nil {
		t.Fatal("a folder without git must be an error")
	}
}

func TestGitHubWebUrl(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"git@github.com:DiamondForgeFr/moltenterm.git":       "https://github.com/DiamondForgeFr/moltenterm",
		"https://github.com/DiamondForgeFr/moltenterm.git\n": "https://github.com/DiamondForgeFr/moltenterm",
		"ssh://git@github.com/a/b":                           "https://github.com/a/b",
		"git@gitlab.com:a/b.git":                             "",
	}
	for in, want := range cases {
		if got := GitHubWebUrl(in); got != want {
			t.Errorf("GitHubWebUrl(%q) = %q, want %q", in, got, want)
		}
	}
}

func ghFake(responses map[string]string, failures map[string]error) Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		key := name + " " + strings.Join(args[:min(2, len(args))], " ")
		if err, ok := failures[key]; ok {
			return nil, err
		}
		return []byte(responses[key]), nil
	}
}

func TestCollectGithubStates(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	missing := CollectGithub(context.Background(), ghFake(nil, map[string]error{"gh repo view": &MissingProgramError{Name: "gh"}}), dir)
	if missing.State != GithubStateNoGh {
		t.Fatalf("gh missing: %+v", missing)
	}
	loggedOut := CollectGithub(context.Background(), ghFake(nil, map[string]error{"gh repo view": errors.New("gh repo view: To get started with GitHub CLI, please run:  gh auth login")}), dir)
	if loggedOut.State != GithubStateLoggedOut {
		t.Fatalf("logged out: %+v", loggedOut)
	}
	noRepo := CollectGithub(context.Background(), ghFake(nil, map[string]error{"gh repo view": errors.New("gh repo view: no git remotes found")}), dir)
	if noRepo.State != GithubStateNoRepo {
		t.Fatalf("no repo: %+v", noRepo)
	}
}

func TestCollectGithubSections(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, ".github", "workflows"), 0755)
	os.WriteFile(filepath.Join(dir, ".github", "workflows", "ci.yml"), []byte("on:\n  schedule:\n    - cron: '17 2 * * *'\n"), 0644)
	os.WriteFile(filepath.Join(dir, ".github", "workflows", "notes.txt"), []byte("x"), 0644)
	run := ghFake(map[string]string{
		"gh repo view":    `{"nameWithOwner":"a/b","url":"https://github.com/a/b"}`,
		"gh pr list":      `[{"number":1}]`,
		"gh run list":     `[]`,
		"gh release list": `[{"tagName":"v1.0.0"}]`,
	}, map[string]error{"gh api repos/a/b/milestones?state=open&per_page=20": errors.New("rate limited")})
	snap := CollectGithub(context.Background(), run, dir)
	if snap.State != GithubStateOk || snap.Repo != "a/b" || string(snap.Prs) != `[{"number":1}]` {
		t.Fatalf("snapshot: %+v", snap)
	}
	if snap.Errors["milestones"] == "" || snap.Milestones != nil {
		t.Fatalf("a failed section is reported alone: %+v", snap.Errors)
	}
	if len(snap.Workflows) != 1 || snap.Workflows[0].Name != "ci.yml" {
		t.Fatalf("workflows: %+v", snap.Workflows)
	}
}

// #1808: SaaSFoundryAI's GitHub answered `gh repo view` with an HTTP 503 once; the refresh replaced the good read, so
// the open milestones v1.1.1 and v1.2.0 left the snapshot and the next station read "nothing for now".
func TestCollectorKeepsTheLastGithubReadOverAnOutage(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	milestones := `[{"number":10,"title":"v1.1.1","due_on":"2026-11-13T00:00:00Z","open_issues":23},{"number":9,"title":"v1.2.0","due_on":"2026-11-27T00:00:00Z","open_issues":29}]`
	good := CollectGithub(context.Background(), ghFake(map[string]string{
		"gh repo view":    `{"nameWithOwner":"DiamondForgeFr/SaasFoundryAI","url":"https://github.com/DiamondForgeFr/SaasFoundryAI"}`,
		"gh pr list":      `[{"number":1}]`,
		"gh run list":     `[]`,
		"gh release list": `[{"tagName":"v1.1.0"}]`,
		"gh api repos/DiamondForgeFr/SaasFoundryAI/milestones?state=open&per_page=20": milestones,
	}, nil), dir)
	outage := CollectGithub(context.Background(), ghFake(nil, map[string]error{
		"gh repo view": errors.New("gh repo view --json nameWithOwner,url: HTTP 503: No server is currently available to service your request."),
	}), dir)
	c := testCollector(t, "", withoutGh, nil)
	c.applyRefresh(dir, refreshPlan{github: true}, nil, nil, good)
	snap := c.applyRefresh(dir, refreshPlan{github: true}, nil, nil, outage)
	if snap.Github.State != GithubStateError || !strings.Contains(snap.Github.Message, "503") {
		t.Fatalf("the outage is still told: %+v", snap.Github)
	}
	if string(snap.Github.Milestones) != milestones || string(snap.Github.Prs) != `[{"number":1}]` || snap.Github.Repo != "DiamondForgeFr/SaasFoundryAI" {
		t.Fatalf("the last good read is kept: %+v", snap.Github)
	}

	partial := CollectGithub(context.Background(), ghFake(map[string]string{
		"gh repo view": `{"nameWithOwner":"DiamondForgeFr/SaasFoundryAI","url":"https://github.com/DiamondForgeFr/SaasFoundryAI"}`,
		"gh pr list":   `[]`,
	}, map[string]error{"gh api repos/DiamondForgeFr/SaasFoundryAI/milestones?state=open&per_page=20": errors.New("HTTP 502")}), dir)
	snap = c.applyRefresh(dir, refreshPlan{github: true}, nil, nil, partial)
	if snap.Github.State != GithubStateOk || string(snap.Github.Milestones) != milestones || string(snap.Github.Prs) != `[]` || snap.Github.Errors["milestones"] == "" {
		t.Fatalf("a failed section keeps its last read, the others are new: %+v", snap.Github)
	}

	signedOut := CollectGithub(context.Background(), ghFake(nil, map[string]error{"gh repo view": errors.New("gh auth login")}), dir)
	snap = c.applyRefresh(dir, refreshPlan{github: true}, nil, nil, signedOut)
	if snap.Github.State != GithubStateLoggedOut || snap.Github.Milestones != nil || snap.Github.Prs != nil {
		t.Fatalf("a definite answer keeps nothing: %+v", snap.Github)
	}
}

// Two panels asking at the same time run one collection; the result is cached and published.
func TestCollectorRunsOneRefreshAndCaches(t *testing.T) {
	t.Parallel()
	dir := makeGitFlowRepo(t)
	var calls atomic.Int32
	release := make(chan struct{})
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			calls.Add(1)
			<-release
			return nil, &MissingProgramError{Name: "gh"}
		}
		return plainRunner(ctx, d, name, args...)
	}
	var published sync.WaitGroup
	published.Add(1)
	var last Snapshot
	cacheDir := t.TempDir()
	c := testCollector(t, cacheDir, run, func(s Snapshot) { last = s; published.Done() })
	first, err := c.Get(dir, time.Minute, false)
	if err != nil || first.Git != nil || !first.Refreshing {
		t.Fatalf("first answer: %+v, %v", first, err)
	}
	second, _ := c.Get(dir, time.Minute, false)
	if !second.Refreshing {
		t.Fatal("the second panel sees the refresh in progress")
	}
	close(release)
	published.Wait()
	if calls.Load() != 1 {
		t.Fatalf("gh ran %d times", calls.Load())
	}
	if last.Git == nil || last.Github.State != GithubStateNoGh || last.Refreshing {
		t.Fatalf("published: %+v", last)
	}
	fresh, _ := c.Get(dir, time.Minute, false)
	if fresh.Refreshing || fresh.Git == nil {
		t.Fatalf("fresh data is not collected again: %+v", fresh)
	}
	reloaded := testCollector(t, cacheDir, run, nil)
	reloaded.now = func() time.Time { return time.Now() }
	cached, _ := reloaded.Get(dir, time.Hour, false)
	if cached.Git == nil || cached.Git.Trunk != "develop" {
		t.Fatalf("cache after restart: %+v", cached)
	}
}

func TestCollectorMissingFolder(t *testing.T) {
	t.Parallel()
	c := testCollector(t, t.TempDir(), withoutGh, nil)
	snap, err := c.Get(filepath.Join(t.TempDir(), "gone"), time.Minute, false)
	if err != nil || !snap.Missing || snap.Refreshing {
		t.Fatalf("missing folder: %+v, %v", snap, err)
	}
	if _, err := c.Get("relative/path", time.Minute, false); err == nil {
		t.Fatal("a relative folder must be refused")
	}
}

func TestStartRefreshThrottlesGithub(t *testing.T) {
	t.Parallel()
	c := testCollector(t, "", withoutGh, nil)
	now := time.Now()
	c.now = func() time.Time { return now }
	state := &projectState{snap: Snapshot{GitAt: now.Add(-5 * time.Second).UnixMilli(), GithubAt: now.Add(-30 * time.Second).UnixMilli()}}
	plan, start := c.startRefreshLocked(state, refreshAsk{forced: true})
	if !start || !plan.git || plan.github {
		t.Fatalf("forced within a minute of the last GitHub read: %+v", plan)
	}
}

// The refresh Get starts in the background is still counted while its git runs, and testCollector's cleanup waits for
// it to publish before the test's folders go (#1874).
func TestTestCollectorWaitsForItsRefreshes(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once
	var published atomic.Bool
	held := func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		once.Do(func() { close(started) })
		<-release
		return withoutGh(ctx, dir, name, args...)
	}
	var c *Collector
	t.Run("refresh", func(t *testing.T) {
		dir := t.TempDir()
		c = testCollector(t, t.TempDir(), held, func(Snapshot) { published.Store(true) })
		t.Cleanup(func() { close(release) })
		if _, err := c.Get(dir, 0, true); err != nil {
			t.Fatal(err)
		}
		<-started
		if n := c.refreshesInFlight(); n != 1 {
			t.Fatalf("a refresh running git is counted: %d", n)
		}
	})
	if n := c.refreshesInFlight(); n != 0 || !published.Load() {
		t.Fatalf("the cleanup waits until the refresh published: in flight %d, published %v", n, published.Load())
	}
}

func TestCollectorReportsThePipeline(t *testing.T) {
	t.Parallel()
	dir := makeGitFlowRepo(t)
	c := testCollector(t, t.TempDir(), withoutGh, nil)
	snap, _ := c.Get(dir, time.Hour, false)
	if snap.Pipeline == nil || snap.Pipeline.Present {
		t.Fatalf("no pipeline yet: %+v", snap.Pipeline)
	}
	os.MkdirAll(filepath.Join(dir, ".molten"), 0755)
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"x","ci":{"jobs":[{"name":"check","run":"make check"}]}}`), 0644)
	snap, _ = c.Get(dir, time.Hour, false)
	if snap.Pipeline == nil || !snap.Pipeline.Valid || len(snap.Pipeline.Pipeline.Ci.Jobs) != 1 {
		t.Fatalf("the pipeline is read on the next request: %+v", snap.Pipeline)
	}
}
