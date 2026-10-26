// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// SaaSFoundryAI's changelog steps (#1142): no check, the changelogs declared in versions.changelogs.
const changelogPipeline = `{"schema":1,"name":"fixture","versions":{"tagprefix":"v","firstpublic":"1.0.0","changelogs":["docs/changelog.md","docs/fr/changelog.md"]},"release":{
	"rc":[
		{"id":"prepare","title":"Prepare","phase":"prepare","run":"echo prepared {tag}"},
		{"id":"changelog-en","title":"Write the {version} section of docs/changelog.md","phase":"cut","manual":"Write the {version} section of docs/changelog.md."},
		{"id":"tag","title":"Tag","phase":"cut","confirm":"Tags.","run":"touch tag-ran"}],
	"public":[
		{"id":"prepare","title":"Prepare","phase":"prepare","run":"echo prepared {tag}"},
		{"id":"changelog-en","title":"Write the {version} section of docs/changelog.md","phase":"cut","manual":"Write the {version} section of docs/changelog.md."},
		{"id":"changelog-fr","title":"Write the {version} section of docs/fr/changelog.md","phase":"cut","manual":"Write the {version} section of docs/fr/changelog.md."},
		{"id":"tag","title":"Tag","phase":"cut","confirm":"Tags.","run":"touch tag-ran"}]}}`

func makeChangelogFixture(t *testing.T) (*Runs, string) {
	r, dir := makeReleaseFixture(t, changelogPipeline)
	gitIn(t, dir, "tag", "v1.0.1")
	for _, c := range []struct{ subject, tag string }{
		{"feat(#20): export the board", ""},
		{"fix(#21): the crash on start", "v1.1.0-1"},
		{"feat(#22): import a board", ""},
		{"chore(#23): CI cache", "v1.1.0-2"},
	} {
		gitIn(t, dir, "commit", "-q", "--allow-empty", "-m", c.subject)
		if c.tag != "" {
			gitIn(t, dir, "tag", c.tag)
		}
	}
	return r, dir
}

func writeChangelog(t *testing.T, dir string, rel string, text string) {
	t.Helper()
	path := filepath.Join(dir, filepath.FromSlash(rel))
	os.MkdirAll(filepath.Dir(path), 0755)
	if err := os.WriteFile(path, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestPublicChangelogSectionCoversTheCandidates(t *testing.T) {
	r, dir := makeChangelogFixture(t)
	res := startRelease(t, r, dir, ReleaseChannelPublic, "v1.1.0")
	waitRun(t, r, dir, res.Run.Id)

	facts, err := r.ReleaseFactsOf(dir)
	if err != nil || facts.ChangelogScope == nil || facts.ChangelogScope.Since != "v1.0.1" || !slices.Equal(facts.ChangelogScope.Steps, []string{"changelog-en", "changelog-fr"}) {
		t.Fatalf("scope: %+v %v", facts.ChangelogScope, err)
	}

	missing, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en"})
	if err != nil || missing.Run != nil || missing.Unproved == nil || !missing.Unproved.Missing || missing.Unproved.Path != "docs/changelog.md" {
		t.Fatalf("no changelog, nothing recorded: %+v %v", missing, err)
	}

	writeChangelog(t, dir, "docs/changelog.md", "# Changelog\n\n## [1.0.1]\n\n- A patch.\n")
	noSection, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en"})
	if err != nil || noSection.Unproved == nil || noSection.Unproved.Missing || noSection.Unproved.Contains != "1.1.0" || len(noSection.Unproved.Uncovered) > 0 {
		t.Fatalf("no 1.1.0 section, nothing recorded: %+v %v", noSection, err)
	}

	// Written as "what changed since the last candidate": the candidates' range is missing.
	writeChangelog(t, dir, "docs/changelog.md", "# Changelog\n\n## [1.1.0] - 2026-10-27\n\n### Added\n\n- Import a board (#22).\n\n## [1.0.1]\n\n- A patch.\n")
	partial, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en"})
	if err != nil || partial.Run != nil || partial.Unproved == nil || partial.Unproved.Since != "v1.0.1" {
		t.Fatalf("a partial section, nothing recorded: %+v %v", partial, err)
	}
	var uncovered []int
	for _, item := range partial.Unproved.Uncovered {
		uncovered = append(uncovered, item.Ticket)
	}
	if !slices.Equal(uncovered, []int{21, 20}) {
		t.Fatalf("uncovered %v: the candidates' tickets, not the chore", uncovered)
	}
	if facts, _ := r.ReleaseFactsOf(dir); facts.Steps["changelog-en"].RunId != "" {
		t.Fatalf("nothing is recorded: %+v", facts.Steps)
	}

	forced, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-en", Force: true})
	if err != nil || forced.Run == nil {
		t.Fatalf("confirmed anyway, it is recorded: %+v %v", forced, err)
	}
	chunk, _ := r.ReadLog(dir, forced.Run.Id, 0)
	if !strings.Contains(chunk.Text, ManualStepForcedLine) || !strings.Contains(chunk.Text, "since v1.0.1: #21, #20") {
		t.Fatalf("the log names what was left out: %q", chunk.Text)
	}

	writeChangelog(t, dir, "docs/fr/changelog.md", "# Changelog\n\n## [1.1.0] - 2026-10-27\n\n- Export (#20), import (#22) et plantage au démarrage corrigé (#21).\n")
	french, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0", Step: "changelog-fr"})
	if err != nil || french.Run == nil || french.Unproved != nil {
		t.Fatalf("a complete French section is recorded at once: %+v %v", french, err)
	}
}

func TestCandidateChangelogSectionStartsAtThePreviousCandidate(t *testing.T) {
	r, dir := makeChangelogFixture(t)
	res := startRelease(t, r, dir, ReleaseChannelRc, "v1.1.0-3")
	waitRun(t, r, dir, res.Run.Id)
	facts, err := r.ReleaseFactsOf(dir)
	if err != nil || facts.ChangelogScope == nil || facts.ChangelogScope.Since != "v1.1.0-2" || !slices.Equal(facts.ChangelogScope.Steps, []string{"changelog-en"}) {
		t.Fatalf("scope: %+v %v", facts.ChangelogScope, err)
	}
	done, err := r.RunReleaseStep(ReleaseStepRequest{Dir: dir, Tag: "v1.1.0-3", Step: "changelog-en"})
	if err != nil || done.Run == nil || done.Unproved != nil {
		t.Fatalf("a candidate's step without a check is recorded at once: %+v %v", done, err)
	}
}
