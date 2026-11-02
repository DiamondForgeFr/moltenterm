// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func TestChangelogHeadingFollowsTheFile(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"keep.md":    "# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-01\n- x\n",
		"plain.md":   "# Changelog\n\n### 1.2.0 (2026-10-01)\n",
		"prefix.md":  "## v1.2.0-3\n",
		"nothing.md": "# Journal\n",
	})
	for path, want := range map[string]string{"keep.md": "## [{version}]", "plain.md": "### {version}", "prefix.md": "## v{version}",
		"nothing.md": DefaultChangelogHeading, "missing.md": DefaultChangelogHeading} {
		if got := changelogHeading(dir, path); got != want {
			t.Fatalf("%s: %q, want %q", path, got, want)
		}
	}
}

func TestFormatCommandByPackageManager(t *testing.T) {
	for lock, want := range map[string]string{"": "npm run format --", "pnpm-lock.yaml": "pnpm run format", "yarn.lock": "yarn run format", "bun.lock": "bun run format"} {
		dir := t.TempDir()
		files := map[string]string{"package.json": `{"scripts": {"format": "prettier --write ."}}`}
		if lock != "" {
			files[lock] = ""
		}
		writeFiles(t, dir, files)
		if got := FormatCommandOf(dir); got != want {
			t.Fatalf("lock %q: %q, want %q", lock, got, want)
		}
	}
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"package.json": `{"scripts": {"lint": "eslint ."}}`})
	if got := FormatCommandOf(dir); got != "" {
		t.Fatalf("no format script: %q", got)
	}
}

func checkOfStep(steps []molten.PipelineStep, id string) *molten.PipelineStepCheck {
	for _, s := range steps {
		if s.Id == id {
			return s.Check
		}
	}
	return nil
}

func TestDraftProposesChecksAndFormat(t *testing.T) {
	dir := saasFoundryFixture(t)
	writeFiles(t, dir, map[string]string{
		"package.json":         `{ "name": "saasfoundryai", "version": "1.0.4", "scripts": { "format": "prettier --write ." } }`,
		"docs/changelog.md":    "# Changelog\n\n## [1.0.4] - 2026-10-20\n",
		"docs/fr/changelog.md": "# Journal\n\n## [1.0.4] - 2026-10-20\n",
	})
	s := MakeSetup(noSf, nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(answer.Errors) > 0 {
		t.Fatalf("the draft is not valid: %v\n%s", answer.Errors, answer.Proposed)
	}
	for _, channel := range [][]molten.PipelineStep{answer.Proposal.Release.Rc, answer.Proposal.Release.Public} {
		en, fr := checkOfStep(channel, "changelog-en"), checkOfStep(channel, "changelog-fr")
		if en == nil || en.Path != "docs/changelog.md" || en.Contains != "## [{version}]" {
			t.Fatalf("changelog-en check: %+v", en)
		}
		if fr == nil || fr.Path != "docs/fr/changelog.md" {
			t.Fatalf("changelog-fr check names the longest path: %+v", fr)
		}
	}
	if answer.Proposal.Versions == nil || answer.Proposal.Versions.Format != "npm run format --" {
		t.Fatalf("versions.format: %+v", answer.Proposal.Versions)
	}
	if !strings.Contains(answer.Proposed, `"format": "npm run format --"`) || !strings.Contains(answer.Proposed, `"contains": "## [{version}]"`) {
		t.Fatalf("the proposed file:\n%s", answer.Proposed)
	}
	if answer.RecordExists {
		t.Fatal("no record in this repository")
	}

	o := answer.Options
	o.NoCheck = []string{"changelog-fr"}
	o.NoFormat = true
	again, err := s.Draft(context.Background(), DraftRequest{Dir: dir, Options: &o})
	if err != nil {
		t.Fatal(err)
	}
	if checkOfStep(again.Proposal.Release.Public, "changelog-fr") != nil || checkOfStep(again.Proposal.Release.Public, "changelog-en") == nil {
		t.Fatalf("the dropped check stays out, the other stays: %+v", again.Proposal.Release.Public)
	}
	if strings.Contains(again.Proposed, `"format"`) && strings.Contains(again.Proposed, "npm run format") {
		t.Fatalf("the dropped formatter stays out:\n%s", again.Proposed)
	}
}

func TestDeclaredFormatterIsKept(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"package.json": `{"scripts": {"format": "prettier --write ."}}`})
	current := &molten.Pipeline{Versions: &molten.PipelineVersions{Format: "npx prettier --write"}}
	p := Proposal{}
	ProposeFormat(dir, Options{}, current, &p)
	if p.Versions != nil {
		t.Fatalf("a declared formatter is not replaced: %+v", p.Versions)
	}
}

func TestLabelsStepChecksItsFirstLabel(t *testing.T) {
	f := Facts{Labels: []VersionLabel{{Path: "AGENTS.md", Line: 3, Text: "- Current version: 1.0.4", Version: "1.0.4"}}}
	o := Options{Labels: []LabelChoice{{Path: "AGENTS.md", Line: 3}}}
	r := &molten.PipelineRelease{Public: []molten.PipelineStep{{Id: "bump-labels", Title: "Bump", Phase: "cut", Manual: "In the release worktree, write {version}."}}}
	ProposeChecks(t.TempDir(), f, o, r)
	got := r.Public[0].Check
	if got == nil || got.Path != "AGENTS.md" || got.Contains != "- Current version: {version}" {
		t.Fatalf("labels check: %+v", got)
	}
	other := &molten.PipelineRelease{Rc: []molten.PipelineStep{{Id: "say-hello", Title: "Say hello", Phase: "cut", Manual: "Tell the team."}}}
	ProposeChecks(t.TempDir(), f, o, other)
	if other.Rc[0].Check != nil {
		t.Fatalf("no file proves this step: %+v", other.Rc[0].Check)
	}
}
