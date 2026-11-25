// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import "testing"

func TestRcBranchMatches(t *testing.T) {
	cases := []struct {
		pattern, name string
		want          bool
	}{
		{"", "rc-1.3.0", true},
		{"", "rc-1.3.0-2", true},
		{"rc-{version}", "rc-10.0.1", true},
		{"release/{version}", "release/1.2.0", true},
		{"release/{version}", "rc-1.2.0", false},
		{"", "rc-", false},
		{"", "feature/12-rc-1.0.0", false},
		{"", "rc-next", false},
		{"no placeholder", "rc-1.0.0", true},
	}
	for _, c := range cases {
		if got := RcBranchMatches(c.pattern, c.name); got != c.want {
			t.Errorf("%q against %q: got %v, want %v", c.name, c.pattern, got, c.want)
		}
	}
}

// #2562: the release pull requests are found with the branches of `molten release`, declared first, then git.
func TestReleasePrKind(t *testing.T) {
	gitFlow := fakeGit("origin/main", "develop", "develop", "main")
	plain := writeBranchFiles(t, "", "")
	cases := []struct {
		name       string
		dir        string
		git        GitQuery
		head, base string
		want       string
	}{
		{"the sync-back: the release branch into the trunk", plain, gitFlow, "main", "develop", ReleasePrSyncBack},
		{"an RC branch into the release branch", plain, gitFlow, "rc-1.3.0", "main", ReleasePrRc},
		{"an RC branch into the trunk is not a release", plain, gitFlow, "rc-1.3.0", "develop", ""},
		{"a feature into the trunk", plain, gitFlow, "feature/12-thing", "develop", ""},
		{"the trunk into the release branch", plain, gitFlow, "develop", "main", ""},
		{"master and develop read from git", plain, fakeGit("", "develop", "develop", "master"), "master", "develop", ReleasePrSyncBack},
		{"declared branches win over git",
			writeBranchFiles(t, "", `{"workflow": {"workingBranch": "dev", "releaseBranch": "stable"}}`), gitFlow,
			"stable", "dev", ReleasePrSyncBack},
		{"the declared RC pattern",
			writeBranchFiles(t, "", `{"workflow": {"branchNaming": {"release": "release/{version}"}}}`), gitFlow,
			"release/1.3.0", "main", ReleasePrRc},
		{"a single-branch project has no sync-back", plain, fakeGit("origin/main", "main", "main"), "main", "main", ""},
		{"a single-branch project's RC", plain, fakeGit("origin/main", "main", "main"), "rc-2.0.0", "main", ReleasePrRc},
	}
	for _, c := range cases {
		if got := ReleasePrKindWith(c.dir, c.git, c.head, c.base); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
