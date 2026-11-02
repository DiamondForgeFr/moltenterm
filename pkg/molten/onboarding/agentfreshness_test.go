// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"os"
	"testing"
)

func TestStaleProfilesIn(t *testing.T) {
	catalog := map[string]AgentFacts{
		"fresh":   {CheckedOn: "2026-11-01"},
		"edge":    {CheckedOn: "2026-10-02"},
		"old":     {CheckedOn: "2026-10-01"},
		"undated": {},
	}
	release, err := ParseReleaseDate("2026-11-01")
	if err != nil {
		t.Fatal(err)
	}
	got := staleProfilesIn(catalog, release, ProfileReleaseMaxAgeDays)
	if len(got) != 2 {
		t.Fatalf("want old and undated, got %+v", got)
	}
	if got[0].Id != "old" || got[0].AgeDays != 31 {
		t.Errorf("old: got %+v", got[0])
	}
	if got[1].Id != "undated" || got[1].AgeDays != -1 {
		t.Errorf("undated: got %+v", got[1])
	}
}

func TestEveryProfileHasACheckedDate(t *testing.T) {
	for id, facts := range agentFactsCatalog {
		if _, err := ParseReleaseDate(facts.CheckedOn); err != nil {
			t.Errorf("%s: checked date %q is not YYYY-MM-DD", id, facts.CheckedOn)
		}
	}
}

// The release-time check of RELEASE.md, "Agent profiles refreshed": run with the candidate's date, e.g.
// MOLTENTERM_RC_DATE=2026-11-20 go test -run '^TestAgentProfilesFreshForRelease$' ./pkg/molten/onboarding/
// Skipped without the date, so the everyday runs never depend on today's date.
func TestAgentProfilesFreshForRelease(t *testing.T) {
	value := os.Getenv(ReleaseDateEnv)
	if value == "" {
		t.Skipf("set %s=YYYY-MM-DD (the release candidate's date) to run the release check", ReleaseDateEnv)
	}
	release, err := ParseReleaseDate(value)
	if err != nil {
		t.Fatalf("%s=%q: want YYYY-MM-DD", ReleaseDateEnv, value)
	}
	for _, p := range StaleProfiles(release, ProfileReleaseMaxAgeDays) {
		if p.AgeDays < 0 {
			t.Errorf("%s: no readable checked date (%q): re-read its vendor pages", p.Id, p.CheckedOn)
			continue
		}
		t.Errorf("%s: checked on %s, %d days before the candidate: re-read its vendor pages", p.Id, p.CheckedOn, p.AgeDays)
	}
}
