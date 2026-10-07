// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestReleaseMilestoneOf(t *testing.T) {
	dir := t.TempDir()
	run := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		joined := name + " " + strings.Join(args, " ")
		switch {
		case joined == "git remote get-url origin":
			return []byte("https://github.com/acme/app.git\n"), nil
		case strings.Contains(joined, "/milestones?"):
			return []byte(`[{"number":12,"title":"1.0.0","html_url":"https://m/12","open_issues":1}]`), nil
		case strings.Contains(joined, "/issues?milestone=12"):
			return []byte(`[{"number":41,"title":"An open bug","html_url":"https://i/41"}]`), nil
		}
		return nil, fmt.Errorf("unexpected %s", joined)
	}
	m, err := ReleaseMilestoneOf(run, ReleaseMilestoneRequest{Dir: dir, Version: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if m == nil || m.Number != 12 || len(m.Issues) != 1 || m.Issues[0].Title != "An open bug" {
		t.Fatalf("milestone: %+v", m)
	}
	if m, err := ReleaseMilestoneOf(run, ReleaseMilestoneRequest{Dir: dir, Version: "2.0.0"}); err != nil || m != nil {
		t.Fatalf("another version: %+v, %v", m, err)
	}
	if _, err := ReleaseMilestoneOf(run, ReleaseMilestoneRequest{Dir: dir, Version: "1.0.0-1"}); err == nil {
		t.Fatalf("a candidate version was accepted")
	}
	offGithub := func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "git" {
			return []byte("/srv/git/app.git\n"), nil
		}
		return nil, fmt.Errorf("gh must not be called off GitHub")
	}
	if m, err := ReleaseMilestoneOf(offGithub, ReleaseMilestoneRequest{Dir: dir, Version: "1.0.0"}); err != nil || m != nil {
		t.Fatalf("off GitHub: %+v, %v", m, err)
	}
}

func TestMentionsRelease(t *testing.T) {
	cases := []struct {
		s    string
		tag  string
		want bool
	}{
		{"chore/sync-back-v1.0.0-1", "v1.0.0-1", true},
		{"chore/sync-main-1.0.0-1", "v1.0.0-1", true},
		{"chore(release): carry v1.0.0 back to develop", "v1.0.0", true},
		{"chore/sync-back-v1.0.0-2", "v1.0.0", false},
		{"chore/sync-back-v1.0.0-10", "v1.0.0-1", false},
		{"chore/sync-back-v11.0.0", "v1.0.0", false},
		{"chore/sync-back-v1.0.0.1", "v1.0.0", false},
	}
	for _, c := range cases {
		if got := mentionsRelease(c.s, c.tag); got != c.want {
			t.Errorf("mentionsRelease(%q, %q) = %v", c.s, c.tag, got)
		}
	}
}
