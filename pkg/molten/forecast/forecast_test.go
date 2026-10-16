// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package forecast

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const testTimeout = time.Minute

// testGitEnv isolates git from the machine's configuration (hooks, signing, identity).
func testGitEnv() []string {
	return append(os.Environ(),
		"GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
}

func testGit(ctx context.Context, input []byte, env []string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(testGitEnv(), env...)
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, stderr.String())
	}
	return stdout.Bytes(), nil
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	out, err := testGit(ctx, nil, nil, append([]string{"-C", dir}, args...)...)
	if err != nil {
		t.Fatalf("%v", err)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, dir string, name string, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

// commitOn checks out branch (created from "from" when given), writes the files and commits; answers the head.
func commitOn(t *testing.T, dir string, branch string, from string, files map[string]string) string {
	t.Helper()
	switch {
	case from != "":
		git(t, dir, "checkout", "-q", "-B", branch, from)
	case git(t, dir, "symbolic-ref", "--short", "HEAD") != branch:
		git(t, dir, "checkout", "-q", branch)
	}
	for name, content := range files {
		write(t, dir, name, content)
	}
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "-m", branch)
	return git(t, dir, "rev-parse", "HEAD")
}

// project is a checkout with crafted PR branches:
//
//	pr1 changes f1 and f2 line 2; pr2 changes f1 line 2; pr3 changes f2 line 2; pr4 adds f4;
//	pr5 (a draft) changes f3 line 2, which the base also changed after pr5 branched.
type project struct {
	dir   string
	base  string
	heads map[int]string
}

func makeProject(t *testing.T) project {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q", "-b", "main")
	p := project{dir: dir, heads: map[int]string{}}
	root := commitOn(t, dir, "main", "", map[string]string{"f1": "a\nb\nc\n", "f2": "x\ny\nz\n", "f3": "1\n2\n3\n"})
	p.heads[5] = commitOn(t, dir, "pr5", root, map[string]string{"f3": "1\nfive\n3\n"})
	p.base = commitOn(t, dir, "main", "", map[string]string{"f3": "1\nbase\n3\n"})
	p.heads[1] = commitOn(t, dir, "pr1", p.base, map[string]string{"f1": "a\none\nc\n", "f2": "x\none\nz\n"})
	p.heads[2] = commitOn(t, dir, "pr2", p.base, map[string]string{"f1": "a\ntwo\nc\n"})
	p.heads[3] = commitOn(t, dir, "pr3", p.base, map[string]string{"f2": "x\nthree\nz\n"})
	p.heads[4] = commitOn(t, dir, "pr4", p.base, map[string]string{"f4": "four\n"})
	git(t, dir, "checkout", "-q", "main")
	return p
}

func (p project) input(method string) Input {
	in := Input{Dir: p.dir, Base: "main", BaseOid: p.base, Method: method}
	for n := 1; n <= 5; n++ {
		in.Prs = append(in.Prs, Pr{Number: n, Branch: fmt.Sprintf("pr%d", n), HeadOid: p.heads[n], Ready: n != 5})
	}
	return in
}

func compute(t *testing.T, e *Engine, in Input) Result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	result, err := e.Compute(ctx, in)
	if err != nil {
		t.Fatalf("Compute: %v", err)
	}
	return result
}

func rowOf(t *testing.T, result Result, number int) Row {
	t.Helper()
	for _, row := range result.Rows {
		if row.Number == number {
			return row
		}
	}
	t.Fatalf("no row for #%d in %+v", number, result.Rows)
	return Row{}
}

func impactsOf(row Row) map[int][]string {
	rtn := map[int][]string{}
	for _, impact := range row.Impacts {
		rtn[impact.Number] = impact.Paths
	}
	return rtn
}

func newEngine(t *testing.T) *Engine {
	return MakeEngine(testGit, filepath.Join(t.TempDir(), "store.git"))
}

func TestForecastImpacts(t *testing.T) {
	p := makeProject(t)
	result := compute(t, newEngine(t), p.input(MethodSquash))
	want := map[int]map[int][]string{
		1: {2: {"f1"}, 3: {"f2"}},
		2: {1: {"f1"}},
		3: {1: {"f2"}},
		4: {},
	}
	for number, impacts := range want {
		row := rowOf(t, result, number)
		if row.State != RowSimulated {
			t.Fatalf("#%d state %q, want simulated", number, row.State)
		}
		if got := impactsOf(row); !reflect.DeepEqual(got, impacts) {
			t.Errorf("#%d impacts %v, want %v", number, got, impacts)
		}
	}
	draft := rowOf(t, result, 5)
	if draft.State != RowConflictsBase || !reflect.DeepEqual(draft.BasePaths, []string{"f3"}) {
		t.Errorf("draft row %+v, want in conflict with the base on f3", draft)
	}
	if result.Approximate {
		t.Errorf("a squash is not approximate")
	}
	// 5 merges onto the base; 4 ready PRs clean on the base, each against the 3 others clean on the base.
	if result.Stats.Merges != 5 || result.Stats.Pairs != 12 || result.Stats.Reused != 0 {
		t.Errorf("stats %+v, want 5 merges and 12 pairs", result.Stats)
	}
}

func TestForecastReusesPairsAfterAPush(t *testing.T) {
	p := makeProject(t)
	e := newEngine(t)
	compute(t, e, p.input(MethodSquash))
	again := compute(t, e, p.input(MethodSquash))
	if again.Stats.Merges != 0 || again.Stats.Pairs != 0 || again.Stats.Reused != 12 {
		t.Fatalf("same heads: stats %+v, want everything reused", again.Stats)
	}
	// A push to pr4 that now conflicts with pr2.
	p.heads[4] = commitOn(t, p.dir, "pr4", "", map[string]string{"f1": "a\nfour\nc\n"})
	git(t, p.dir, "checkout", "-q", "main")
	pushed := compute(t, e, p.input(MethodSquash))
	// Only pr4's row and column: 1 merge onto the base, 3 pairs as A and 3 as B.
	if pushed.Stats.Merges != 1 || pushed.Stats.Pairs != 6 || pushed.Stats.Reused != 6 {
		t.Fatalf("after a push: stats %+v, want 1 merge, 6 pairs, 6 reused", pushed.Stats)
	}
	if got := impactsOf(rowOf(t, pushed, 4)); !reflect.DeepEqual(got, map[int][]string{1: {"f1"}, 2: {"f1"}}) {
		t.Errorf("#4 impacts %v after its push", got)
	}
	if got := impactsOf(rowOf(t, pushed, 2)); !reflect.DeepEqual(got, map[int][]string{1: {"f1"}, 4: {"f1"}}) {
		t.Errorf("#2 impacts %v after #4's push", got)
	}
}

func TestForecastBaseMoveAfterAMerge(t *testing.T) {
	p := makeProject(t)
	e := newEngine(t)
	compute(t, e, p.input(MethodSquash))
	// pr1 is merged: the base moves and pr1 leaves the list; pr2 and pr3 now conflict with the base.
	git(t, p.dir, "merge", "-q", "--no-ff", "-m", "merge pr1", "pr1")
	p.base = git(t, p.dir, "rev-parse", "HEAD")
	in := p.input(MethodSquash)
	in.Prs = in.Prs[1:]
	result := compute(t, e, in)
	if result.Stats.Reused != 0 || result.Stats.Merges != 4 {
		t.Errorf("a base move recomputes every merge: stats %+v", result.Stats)
	}
	for _, number := range []int{2, 3} {
		if row := rowOf(t, result, number); row.State != RowConflictsBase {
			t.Errorf("#%d state %q, want conflictsbase after pr1's merge", number, row.State)
		}
	}
	if row := rowOf(t, result, 4); len(row.Impacts) != 0 {
		t.Errorf("#4 impacts %v, want none", row.Impacts)
	}
}

// A PR stacked on another: with a merge commit, the merge base of the stacked PR is the first one's head, so it
// stays clean; a squash leaves the base as the merge base, and both changed the same line.
func TestForecastMethodMatters(t *testing.T) {
	p := makeProject(t)
	stacked := commitOn(t, p.dir, "pr6", "pr1", map[string]string{"f1": "a\nsix\nc\n"})
	git(t, p.dir, "checkout", "-q", "main")
	in := Input{Dir: p.dir, Base: "main", BaseOid: p.base, Prs: []Pr{
		{Number: 1, Branch: "pr1", HeadOid: p.heads[1], Ready: true},
		{Number: 6, Branch: "pr6", HeadOid: stacked, Ready: true},
	}}
	e := newEngine(t)
	in.Method = MethodMerge
	if got := impactsOf(rowOf(t, compute(t, e, in), 1)); len(got) != 0 {
		t.Errorf("merge commit: #1 impacts %v, want none", got)
	}
	in.Method = MethodSquash
	if got := impactsOf(rowOf(t, compute(t, e, in), 1)); !reflect.DeepEqual(got, map[int][]string{6: {"f1"}}) {
		t.Errorf("squash: #1 impacts %v, want #6 on f1", got)
	}
	in.Method = MethodRebase
	result := compute(t, e, in)
	if !result.Approximate {
		t.Errorf("a rebase merge is approximate")
	}
	if got := impactsOf(rowOf(t, result, 1)); !reflect.DeepEqual(got, map[int][]string{6: {"f1"}}) {
		t.Errorf("rebase: #1 impacts %v, want #6 on f1", got)
	}
}

func snapshotCheckout(t *testing.T, dir string) string {
	t.Helper()
	return git(t, dir, "for-each-ref") + "\n--\n" + git(t, dir, "status", "--porcelain", "--untracked-files=all") +
		"\n--\n" + git(t, dir, "count-objects", "-v") + "\n--\n" + git(t, dir, "worktree", "list", "--porcelain")
}

// The head of a PR the project lacks is fetched from origin into the private store; the checkout is not written.
func TestForecastFetchesIntoTheStoreOnly(t *testing.T) {
	p := makeProject(t)
	origin := filepath.Join(t.TempDir(), "origin.git")
	git(t, p.dir, "clone", "-q", "--bare", p.dir, origin)
	// Another clone pushes pr7, which the project never saw.
	other := filepath.Join(t.TempDir(), "other")
	git(t, p.dir, "clone", "-q", origin, other)
	pr7 := commitOn(t, other, "pr7", "origin/main", map[string]string{"f2": "x\nseven\nz\n"})
	git(t, other, "push", "-q", "origin", "pr7")
	git(t, p.dir, "remote", "add", "origin", origin)
	before := snapshotCheckout(t, p.dir)

	in := p.input(MethodSquash)
	in.Prs = append(in.Prs, Pr{Number: 7, Branch: "pr7", HeadOid: pr7, Ready: true})
	in.Prs = append(in.Prs, Pr{Number: 8, Branch: "pr8", HeadOid: strings.Repeat("ab", 20), Ready: true})
	result := compute(t, newEngine(t), in)
	if result.Stats.Fetched != 1 {
		t.Errorf("fetched %d heads, want 1", result.Stats.Fetched)
	}
	if got := impactsOf(rowOf(t, result, 7)); !reflect.DeepEqual(got, map[int][]string{1: {"f2"}, 3: {"f2"}}) {
		t.Errorf("#7 impacts %v", got)
	}
	if row := rowOf(t, result, 8); row.State != RowMissing {
		t.Errorf("#8 state %q, want missing", row.State)
	}
	if after := snapshotCheckout(t, p.dir); after != before {
		t.Errorf("the checkout changed:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

func TestForecastRefusesBadInput(t *testing.T) {
	e := newEngine(t)
	ctx := context.Background()
	oid := strings.Repeat("a", 40)
	bad := []Input{
		{Dir: "relative", Base: "main", BaseOid: oid, Method: MethodMerge},
		{Dir: "/x", Base: "-main", BaseOid: oid, Method: MethodMerge},
		{Dir: "/x", Base: "main", BaseOid: "HEAD", Method: MethodMerge},
		{Dir: "/x", Base: "main", BaseOid: oid, Method: "octopus"},
		{Dir: "/x", Base: "main", BaseOid: oid, Method: MethodMerge, Prs: []Pr{{Number: 1, Branch: "a..b", HeadOid: oid}}},
		{Dir: "/x", Base: "main", BaseOid: oid, Method: MethodMerge, Prs: []Pr{{Number: 1, Branch: "a", HeadOid: oid}, {Number: 1, Branch: "b", HeadOid: oid}}},
	}
	for i, in := range bad {
		if _, err := e.Compute(ctx, in); err == nil {
			t.Errorf("input %d accepted", i)
		}
	}
}

func TestParseMergeTree(t *testing.T) {
	tree := strings.Repeat("1", 40)
	out := "0\x00" + tree + "\x00b\x00a\x00a\x00\x00" + "1\x00" + tree + "\x00\x00"
	got, err := parseMergeTree([]byte(out), 2)
	if err != nil {
		t.Fatal(err)
	}
	want := []mergeResult{{clean: false, tree: tree, paths: []string{"a", "b"}}, {clean: true, tree: tree}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
	if _, err := parseMergeTree([]byte(out), 3); err == nil {
		t.Errorf("a short answer is an error")
	}
}
