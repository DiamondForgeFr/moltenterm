// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The pull-request flow (#1046) on the throwaway fixture: the release branch is never pushed by the chain; the fake gh
// plays GitHub, merging the pull request into the bare origin itself when asked to.

type fakePrGitHub struct {
	t      *testing.T
	f      *fixture
	lock   sync.Mutex
	open   bool
	merged bool
	title  string
	head   string
	// The required checks' buckets answered in turn; the last one repeats.
	checks []string
	// mergeStateStatus answered by pr view.
	state  string
	calls  []string
	merges [][]string
	clones int
}

func (g *fakePrGitHub) run(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name != "gh" {
		return ExecRunner(ctx, dir, name, args...)
	}
	g.lock.Lock()
	defer g.lock.Unlock()
	joined := strings.Join(args, " ")
	g.calls = append(g.calls, joined)
	switch {
	case strings.HasPrefix(joined, "pr list"):
		state := ""
		for i, a := range args {
			if a == "--state" {
				state = args[i+1]
			}
		}
		if (state == "open" && g.open) || (state == "merged" && g.merged) {
			pr := map[string]any{"number": 9, "url": "https://github.example/pr/9", "title": g.title, "state": strings.ToUpper(state), "headRefOid": g.head}
			data, _ := json.Marshal([]any{pr})
			return data, nil
		}
		return []byte("[]"), nil
	case strings.HasPrefix(joined, "pr create"):
		for i, a := range args {
			if a == "--title" {
				g.title = args[i+1]
			}
		}
		g.open = true
		g.head = gitIn(g.t, g.f.origin, "rev-parse", "rc-1.0.0")
		return []byte("https://github.example/pr/9\n"), nil
	case strings.HasPrefix(joined, "pr checks"):
		bucket := g.checks[0]
		if len(g.checks) > 1 {
			g.checks = g.checks[1:]
		}
		data := fmt.Sprintf(`[{"name":"CI / Required gate","state":%q,"bucket":%q,"link":"https://ci/7"}]`, strings.ToUpper(bucket), bucket)
		if bucket == "pending" {
			return []byte(data), fmt.Errorf("gh pr checks: some checks are still pending")
		}
		return []byte(data), nil
	case strings.HasPrefix(joined, "pr view"):
		return []byte(fmt.Sprintf(`{"state":"OPEN","mergeStateStatus":%q}`, g.state)), nil
	case strings.HasPrefix(joined, "pr merge"):
		g.merges = append(g.merges, args)
		g.clones++
		clone := filepath.Join(g.f.base, fmt.Sprintf("github-merge-%d", g.clones))
		gitIn(g.t, g.f.base, "clone", "--quiet", "-b", "main", g.f.origin, clone)
		gitIn(g.t, clone, "merge", "--quiet", "--no-ff", "-m", "Merge pull request #9 from rc-1.0.0", "origin/rc-1.0.0")
		gitIn(g.t, clone, "push", "--quiet", "origin", "main")
		g.open, g.merged = false, true
		return nil, nil
	}
	return nil, fmt.Errorf("fake gh: unexpected %s", joined)
}

func (g *fakePrGitHub) called(prefix string) int {
	g.lock.Lock()
	defer g.lock.Unlock()
	n := 0
	for _, c := range g.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

// divergeMain makes main and develop diverge as SaaSFoundryAI's did: a fix cherry-picked onto main, then changed again
// on develop, so that merging them conflicts though main holds nothing develop lacks.
func divergeMain(t *testing.T, f *fixture) {
	t.Helper()
	f.commitOnDevelop(t, "fix(#5): the first line")
	fix := gitIn(t, f.checkout, "rev-parse", "HEAD")
	gitIn(t, f.checkout, "checkout", "--quiet", "-B", "hotfix", "origin/main")
	// -x: within the same second, a plain cherry-pick onto the same parent would be the very same commit.
	gitIn(t, f.checkout, "cherry-pick", "-x", fix)
	gitIn(t, f.checkout, "push", "--quiet", "origin", "HEAD:main")
	gitIn(t, f.checkout, "checkout", "--quiet", "develop")
	path := filepath.Join(f.checkout, "app.txt")
	writeFile(t, path, strings.Replace(readFile(t, path), "fix(#5): the first line", "fix(#6): the first line, again", 1))
	gitIn(t, f.checkout, "commit", "--quiet", "-am", "fix(#6): the first line, again")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
}

func TestPrFlowEndToEnd(t *testing.T) {
	f := makeFixture(t)
	writeFile(t, filepath.Join(f.checkout, ".saasfoundry.json"), `{"workflow":{"branchNaming":{"release":"rc-{version}"}}}`)
	gitIn(t, f.checkout, "add", ".saasfoundry.json")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "chore(#4): the harness")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	divergeMain(t, f)
	mainBefore := f.originRef(t, "main")
	gh := &fakePrGitHub{t: t, f: f, checks: []string{"pending", "pending", "pass"}, state: "BLOCKED"}
	e := f.env()
	e.Run = gh.run
	ctx := context.Background()

	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	if got := gitIn(t, f.worktree(), "symbolic-ref", "--short", "HEAD"); got != "rc-1.0.0" {
		t.Fatalf("the worktree is on %s, want rc-1.0.0", got)
	}
	mustFail(t, f, "open-pr without the reconciliation", e.OpenPr(ctx, "v1.0.0-1"), "molten release reconcile v1.0.0-1")
	if subject := gitIn(t, f.worktree(), "log", "-1", "--format=%s"); strings.HasPrefix(subject, "chore(release)") {
		t.Fatalf("the refused open-pr left its release commit")
	}
	mustRun(t, f, "reconcile", e.Reconcile(ctx, "v1.0.0-1"))
	mustRun(t, f, "reconcile again", e.Reconcile(ctx, "v1.0.0-1"))
	if !strings.Contains(f.out.String(), "nothing to reconcile") {
		t.Errorf("a second reconcile should do nothing:\n%s", f.out.String())
	}
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0-1"))
	if f.originRef(t, "main") != mainBefore {
		t.Fatalf("open-pr pushed main")
	}
	if got := f.originFile(t, "rc-1.0.0", "package.json"); !strings.Contains(got, `"1.0.0-1"`) {
		t.Fatalf("rc-1.0.0 does not carry the bump:\n%s", got)
	}
	if gh.title != "chore(release): v1.0.0-1 (rc)" || gh.called("pr create --base main --head rc-1.0.0") != 1 {
		t.Fatalf("pull request: %q %v", gh.title, gh.calls)
	}
	mustRun(t, f, "open-pr again", e.OpenPr(ctx, "v1.0.0-1"))
	if gh.called("pr create") != 1 || !strings.Contains(f.out.String(), "already open") {
		t.Fatalf("a second open-pr must update the open pull request: %v", gh.calls)
	}
	mustFail(t, f, "tag before the merge", e.Tag(ctx, "v1.0.0-1"), "merge its pull request first")

	gh.state = "CLEAN"
	mustRun(t, f, "merge-pr", e.MergePr(ctx, "v1.0.0-1", MergePrOptions{Method: "merge"}))
	if gh.called("pr checks 9 --required") != 3 || len(gh.merges) != 1 {
		t.Fatalf("merge-pr must wait for the required check then merge once: %v", gh.calls)
	}
	if got := strings.Join(gh.merges[0], " "); !strings.Contains(got, "--merge --match-head-commit "+gh.head) {
		t.Fatalf("merge call: %s", got)
	}
	mustRun(t, f, "merge-pr again", e.MergePr(ctx, "v1.0.0-1", MergePrOptions{}))
	if len(gh.merges) != 1 {
		t.Fatalf("an already merged pull request must not be merged again")
	}

	mustRun(t, f, "tag", e.Tag(ctx, "v1.0.0-1"))
	tagged := f.originRef(t, "v1.0.0-1^{commit}")
	if tagged != f.originRef(t, "main") {
		t.Fatalf("the tag is not on main's merge commit")
	}
	if parents := strings.Fields(gitIn(t, f.origin, "log", "-1", "--format=%P", tagged)); len(parents) != 2 {
		t.Fatalf("the tagged commit is not a merge commit: %v", parents)
	}
	if got := f.originFile(t, "v1.0.0-1", "package.json"); !strings.Contains(got, `"1.0.0-1"`) {
		t.Fatalf("the tagged tree does not carry the bump:\n%s", got)
	}

	mustRun(t, f, "sync-back", e.SyncBack(ctx, "v1.0.0-1"))
	if got := f.originFile(t, "chore/sync-back-v1.0.0-1", "package.json"); !strings.Contains(got, `"1.0.0-1"`) {
		t.Fatalf("the sync-back branch does not carry the release commit:\n%s", got)
	}
	if subject := gitIn(t, f.origin, "log", "-1", "--format=%s", "chore/sync-back-v1.0.0-1"); subject != "chore(release): v1.0.0-1 (rc)" {
		t.Fatalf("sync-back carried %q, want the release commit", subject)
	}

	// The next release: the sync-back merged, develop moved on; main now holds the merge commit and the release commit
	// develop only has as a cherry-pick. The preparation merges main in (their change is the same), no reconciliation.
	gitIn(t, f.origin, "update-ref", "refs/heads/develop", f.originRef(t, "chore/sync-back-v1.0.0-1"))
	f.commitOnDevelop(t, "feat(#8): a third feature")
	gh.open, gh.merged, gh.title, gh.checks, gh.merges = false, false, "", []string{"pass"}, nil
	mustRun(t, f, "prepare --pr the next release", e.PreparePr(ctx, "v1.0.0-2"))
	if !strings.Contains(f.out.String(), "main merged into rc-1.0.0: it holds nothing develop lacks") {
		t.Fatalf("the preparation should merge main in:\n%s", f.out.String())
	}
	mustRun(t, f, "open-pr the next release", e.OpenPr(ctx, "v1.0.0-2"))
	mustRun(t, f, "merge-pr the next release", e.MergePr(ctx, "v1.0.0-2", MergePrOptions{}))
	mustRun(t, f, "tag the next release", e.Tag(ctx, "v1.0.0-2"))
	if got := f.originFile(t, "v1.0.0-2", "package.json"); !strings.Contains(got, `"1.0.0-2"`) {
		t.Fatalf("the second release is not tagged with its bump:\n%s", got)
	}
	if got := f.originFile(t, "v1.0.0-2", "app.txt"); !strings.Contains(got, "feat(#8): a third feature") {
		t.Fatalf("the second release lacks develop's work:\n%s", got)
	}
}

func TestPrFlowRefusals(t *testing.T) {
	f := makeFixture(t)
	divergeMain(t, f)
	gitIn(t, f.checkout, "checkout", "--quiet", "-B", "hotfix", "origin/main")
	writeFile(t, filepath.Join(f.checkout, "only-on-main.txt"), "x\n")
	gitIn(t, f.checkout, "add", "only-on-main.txt")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "fix(#7): only on main")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "HEAD:main")
	gitIn(t, f.checkout, "checkout", "--quiet", "develop")
	gh := &fakePrGitHub{t: t, f: f, checks: []string{"fail"}, state: "BLOCKED"}
	e := f.env()
	e.Run = gh.run
	ctx := context.Background()

	mustFail(t, f, "reconcile unprepared", e.Reconcile(ctx, "v1.0.0-1"), "prepare v1.0.0-1 --pr")
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	mustFail(t, f, "reconcile with a commit only on main", e.Reconcile(ctx, "v1.0.0-1"), "fix(#7): only on main")
	mustFail(t, f, "merge-pr without a pull request", e.MergePr(ctx, "v1.0.0-1", MergePrOptions{}), "open it first")
	mustFail(t, f, "a merge method", e.MergePr(ctx, "v1.0.0-1", MergePrOptions{Method: "octopus"}), "--method must be")
	gh.open, gh.title = true, "chore(release): v1.0.0-1 (rc)"
	mustFail(t, f, "a failed required check", e.MergePr(ctx, "v1.0.0-1", MergePrOptions{}), "CI / Required gate failed")
	gh.checks, gh.state = []string{"pass"}, "BEHIND"
	mustFail(t, f, "a branch behind", e.MergePr(ctx, "v1.0.0-1", MergePrOptions{}), "open-pr again")
	if len(gh.merges) != 0 {
		t.Fatalf("nothing may be merged")
	}
}

func TestRcBranch(t *testing.T) {
	p := &Project{}
	p.Rules.TagPrefix = "v"
	v, ok := p.Rules.ReleaseOf("v1.2.0-3")
	if !ok {
		t.Fatal("v1.2.0-3 is a release tag")
	}
	for pattern, want := range map[string]string{"": "rc-1.2.0", "release/{version}": "release/1.2.0", "rc": "rc-1.2.0"} {
		p.RcPattern = pattern
		if got, err := p.RcBranch(v); err != nil || got != want {
			t.Errorf("%q: %q, %v; want %q", pattern, got, err, want)
		}
	}
	p.RcPattern = "rc {version}"
	if _, err := p.RcBranch(v); err == nil {
		t.Errorf("a space must be refused")
	}
}
