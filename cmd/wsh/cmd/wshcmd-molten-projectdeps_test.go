// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
)

func TestMoltenProjectDepsRouting(t *testing.T) {
	for _, line := range []string{"molten project deps", "molten project deps --json"} {
		found, _, err := rootCmd.Find(strings.Fields(line))
		if err != nil || found.Name() != "deps" {
			t.Fatalf("%q: %v, %v", line, found, err)
		}
	}
}

func TestFormatMoltenProjectDeps(t *testing.T) {
	stale := moltenDepState{
		Project: "Notulia", SourceName: "Notulia", Paths: []string{"features/*.json"}, Output: []string{"src/data/features.json"},
		Branch: "develop", Ref: "origin/develop", State: moltenDepStateStale, Trunk: "develop",
		Synced:  &moltenDepCommit{Sha: "aaaaaaaaaa", Time: 1000, Subject: "chore: sync features"},
		Source:  &moltenDepCommit{Sha: "bbbbbbbbbb", Time: 2000, Subject: "feat(#1151): new feature"},
		Commits: []moltenDepCommit{{Sha: "bbbbbbbbbb", Time: 2000, Subject: "feat(#1151): new feature", Tickets: []string{"1151"}}},
		Changed: []string{"features/export.json"}, Sync: "node scripts/sync-features.mjs",
	}
	out := formatMoltenProjectDeps(MoltenProjectDepsStatus{Linked: true, Project: "notulia-website", Deps: []moltenDepState{stale}})
	for _, want := range []string{"notulia-website: 1 dependency", "Notulia: STALE", "on develop (origin/develop)", "changed: features/export.json",
		"since the last sync: 1 commit", "bbbbbbb feat(#1151): new feature [#1151]", "last sync: aaaaaaa chore: sync features", "sync: node scripts/sync-features.mjs"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}

	never := stale
	never.Synced = nil
	never.State = moltenDepStateUncommitted
	never.Uncommitted = []string{"src/data/features.json"}
	out = formatMoltenDep(never)
	if !strings.Contains(out, "STALE: synced, not committed") || !strings.Contains(out, "last sync: never") || !strings.Contains(out, "not committed: src/data/features.json") {
		t.Fatalf("never synced, output not committed:\n%s", out)
	}

	missing := moltenDepState{Project: "Nope", Paths: []string{"a"}, Output: []string{"b"}, State: moltenDepStateSourceNotFound, Problem: "no other project linked"}
	out = formatMoltenDep(missing)
	if !strings.Contains(out, "Nope: source not found") || !strings.Contains(out, "no other project linked") || strings.Contains(out, "last sync") {
		t.Fatalf("source not found:\n%s", out)
	}

	inSync := stale
	inSync.State, inSync.Commits, inSync.Changed = moltenDepStateInSync, nil, nil
	if out = formatMoltenDep(inSync); !strings.Contains(out, "Notulia: in sync") || strings.Contains(out, "since the last sync") {
		t.Fatalf("in sync:\n%s", out)
	}

	if out = formatMoltenProjectDeps(MoltenProjectDepsStatus{Linked: true, Project: "App"}); !strings.Contains(out, "declares no dependency") {
		t.Fatalf("none declared:\n%s", out)
	}
	if out = formatMoltenProjectDeps(MoltenProjectDepsStatus{}); !strings.Contains(out, "not linked") {
		t.Fatalf("not linked:\n%s", out)
	}
}
