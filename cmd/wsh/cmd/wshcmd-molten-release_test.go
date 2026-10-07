// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/release"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

func TestFormatMoltenReleasePlan(t *testing.T) {
	out := formatMoltenReleasePlan([]release.PlanReport{
		{
			PlanResult: versions.PlanResult{Channel: "rc", Tag: "v1.0.0-1", Base: "1.0.0", Reason: "First public release: a choice, not a calculation."},
			Milestone: &release.Milestone{Title: "1.0.0", Url: "https://m/12", Issues: []release.MilestoneIssue{
				{Number: 41, Title: "An open bug"},
			}},
		},
		{PlanResult: versions.PlanResult{Channel: "public", Reason: "Nothing a user would see since v1.0.0."}},
	})
	for _, want := range []string{
		"Release candidate: v1.0.0-1.",
		"Ships milestone 1.0.0 (https://m/12).",
		"Warning: 1 open issue(s), reported, not blocking:",
		"#41 An open bug",
		"Public release: none. Nothing a user would see",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("plan output lacks %q:\n%s", want, out)
		}
	}
}

func TestMoltenReleaseChannels(t *testing.T) {
	defer func() { moltenReleaseRc, moltenReleasePublic = false, false }()
	moltenReleaseRc, moltenReleasePublic = false, false
	if got := moltenReleaseChannels(); len(got) != 2 {
		t.Fatalf("no flag: %v", got)
	}
	moltenReleaseRc = true
	if got := moltenReleaseChannels(); len(got) != 1 || got[0] != "rc" {
		t.Fatalf("--rc: %v", got)
	}
	moltenReleaseRc, moltenReleasePublic = false, true
	if got := moltenReleaseChannels(); len(got) != 1 || got[0] != "public" {
		t.Fatalf("--public: %v", got)
	}
}
