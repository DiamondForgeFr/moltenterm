// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// ghPosts records the statuses the local CI posts through gh, and refuses them as gh does in the tests.
type ghPosts struct {
	lock  sync.Mutex
	posts []string
}

func (g *ghPosts) run(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	if name != "gh" {
		return plainRunner(ctx, dir, name, args...)
	}
	g.lock.Lock()
	defer g.lock.Unlock()
	g.posts = append(g.posts, strings.Join(args, " "))
	return nil, errors.New("gh: not in tests")
}

func (g *ghPosts) on(sha string) []string {
	g.lock.Lock()
	defer g.lock.Unlock()
	var rtn []string
	for _, p := range g.posts {
		if strings.Contains(p, "statuses/"+sha) {
			rtn = append(rtn, p)
		}
	}
	return rtn
}

// #2141: a head rebased onto the same code (an agent's rebase tested before its push) is green for the local CI, and
// its statuses are posted on it; other code is not.
func TestCiGreenOnTheSameCode(t *testing.T) {
	t.Parallel()
	c, dir := makeCiFixture(t, `{"statuses":"github","jobs":[{"name":"check","run":"echo ok"},{"name":"unit","run":"echo ok"}]}`)
	gh := &ghPosts{}
	c.run = gh.run
	startCi(t, c, dir, CiRunRequest{Branch: "develop"})
	gitIn(t, dir, "commit", "-q", "--allow-empty", "-m", "rebased")
	rebased := gitIn(t, dir, "rev-parse", "HEAD")
	if c.Busy(dir) {
		t.Fatalf("nothing runs")
	}
	if !c.GreenOn(dir, rebased) {
		t.Fatalf("the same code passed")
	}
	deadline := time.Now().Add(time.Minute)
	for len(gh.on(rebased)) < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("the statuses of both jobs are posted on the rebased head: %v", gh.on(rebased))
		}
		time.Sleep(testPoll)
	}
	posts := gh.on(rebased)
	slices.Sort(posts)
	if !strings.Contains(posts[0], "context=local-check") || !strings.Contains(posts[1], "context=local-unit") || !strings.Contains(posts[0], "state=success") {
		t.Errorf("posts: %v", posts)
	}
	writeFile(t, dir+"/b.txt", "b\n")
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "new code")
	if c.GreenOn(dir, gitIn(t, dir, "rev-parse", "HEAD")) {
		t.Errorf("new code has no verdict yet")
	}
	if c.GreenOn(dir, "not-a-sha") || c.GreenOn(dir, strings.Repeat("f", 40)) {
		t.Errorf("an unknown commit is not green")
	}
}

func TestCiSameCodeFirstTry(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if !firstTry(dir, "post@x") || firstTry(dir, "post@x") || !firstTry(dir, "fetch@x") {
		t.Fatalf("each thing once per project and commit")
	}
}
