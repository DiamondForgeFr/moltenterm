// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// False version labels (#1791): MoltenTerm's own MANIFESTO.md shows a mod format example, "version: 0.1.0", inside a
// fenced YAML block, and its docs site's package.json names "0.0.0"; neither is a label of the product.

func labelKeys(labels []VersionLabel) string {
	var keys []string
	for _, l := range labels {
		keys = append(keys, fmt.Sprintf("%s:%d", l.Path, l.Line))
	}
	return strings.Join(keys, ",")
}

const manifestoLike = "# Manifesto\n" +
	"\n" +
	"Current version: 1.2.3\n" +
	"\n" +
	"```yaml\n" +
	"# Illustrative only\n" +
	"version: 0.1.0\n" +
	"```\n" +
	"\n" +
	"~~~~\n" +
	"```\n" +
	"version: 0.2.0\n" +
	"~~~~\n" +
	"\n" +
	"  ```\n" +
	"  Latest version: 1.2.3\n" +
	"  ```\n" +
	"\n" +
	"Docs version: 0.3.0\n"

func TestDetectLabelsSkipsMarkdownCodeBlocks(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"MANIFESTO.md":      manifestoLike,
		"docs/guide.mdx":    "```js\nconst version = \"1.2.3\";\n```\n**v1.2.3**\n",
		"docs/notes.txt":    "```\nversion: 0.9.0\n```\n",
		"docs/unclosed.md":  "```\nversion: 0.4.0\n",
		"docs/indented.mdx": "    version: 0.5.0\n",
	})
	got := labelKeys(DetectLabels(dir, "1.2.3", nil))
	// A .txt file has no fences: its line stays a label; an indented code block is not a fence and stays one too.
	want := "MANIFESTO.md:3,MANIFESTO.md:19,docs/guide.mdx:4,docs/indented.mdx:1,docs/notes.txt:2"
	if got != want {
		t.Fatalf("labels: %s, want %s", got, want)
	}
}

func TestDetectLabelsSkipsOtherPackagesManifests(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"docs/package.json":         "{\n  \"name\": \"docs\",\n  \"version\": \"0.0.0\",\n  \"private\": true\n}\n",
		"docs/site/package.json":    "{\n  \"name\": \"site\",\n  \"version\": \"1.2.3\"\n}\n",
		"docs/pubspec.yaml":         "name: docs\nversion: 0.1.0\n",
		"docs/config/settings.json": "{\n  \"version\": \"0.7.0\"\n}\n",
	})
	got := labelKeys(DetectLabels(dir, "1.2.3", nil))
	// A manifest holding the current version is the product's after all; a plain JSON file is no manifest.
	want := "docs/config/settings.json:2,docs/site/package.json:3"
	if got != want {
		t.Fatalf("labels: %s, want %s", got, want)
	}
}

// This repository's layout (#1791): the update the Release menu offered came from MANIFESTO.md:168, a top-level file,
// so kept by default; docs/package.json was found too.
func TestMoltenTermLayoutOffersNoLabels(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"package.json":      "{\n  \"name\": \"moltenterm\",\n  \"version\": \"1.0.0-6\"\n}\n",
		"MANIFESTO.md":      "# Moltenterm\n\n```yaml\n# Illustrative only\nname: my-mod\nversion: 0.1.0\n```\n",
		"docs/package.json": "{\n  \"name\": \"docs\",\n  \"version\": \"0.0.0\",\n  \"private\": true\n}\n",
	})
	commitless := Detect(dir)
	if commitless.CurrentVersion != "1.0.0-6" || len(commitless.Labels) != 0 {
		t.Fatalf("current %q, labels: %s", commitless.CurrentVersion, labelKeys(commitless.Labels))
	}
}

// pre1046FalseLabel: the pre-#1046 repository, with one more label the developer will dismiss.
func pre1046FalseLabel(t *testing.T) string {
	t.Helper()
	dir := pre1046Repository(t, nil)
	writeFiles(t, dir, map[string]string{"NOTES.md": "# Notes\n\nPlugin version: 0.1.0\n"})
	gitIn(t, dir, "add", "NOTES.md")
	gitIn(t, dir, "commit", "--quiet", "-m", "docs(#3): notes")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")
	return dir
}

func labelByPath(labels []VersionLabel, path string) (VersionLabel, bool) {
	for _, l := range labels {
		if l.Path == path {
			return l, true
		}
	}
	return VersionLabel{}, false
}

// A label dismissed as "Not a version label" is recorded in versions.notlabels by the update's pull request; once
// every label is declared or dismissed, the Release menu's check offers no update.
func TestDismissedLabelIsNotOfferedAgain(t *testing.T) {
	dir := pre1046FalseLabel(t)
	s := prSetup(t, &fakeForge{}, "[]")
	ctx := context.Background()
	check, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(check.Reasons) != 1 || check.Reasons[0].Code != UpdateReasonLabels || check.Reasons[0].Detail != "4" {
		t.Fatalf("reasons: %+v", check.Reasons)
	}
	f := Detect(dir)
	notes, ok := labelByPath(f.Labels, "NOTES.md")
	if !ok {
		t.Fatalf("NOTES.md is no label: %s", labelKeys(f.Labels))
	}
	// The developer keeps the real labels and dismisses the false one, as LabelsSection's button does.
	o := *check.Options
	o.NotLabels = []molten.PipelineNotLabel{NotLabelOf(notes)}
	adjusted, err := s.Check(ctx, CheckRequest{Dir: dir, Options: &o})
	if err != nil {
		t.Fatal(err)
	}
	codes := []string{}
	for _, r := range adjusted.Reasons {
		codes = append(codes, r.Code+"="+r.Detail)
	}
	if got := strings.Join(codes, ","); got != "labels=3,notlabels=1,adjusted" && got != "labels=3,notlabels=1" {
		t.Fatalf("reasons: %s", got)
	}
	if strings.Contains(adjusted.Proposed, `"path": "NOTES.md", "format"`) || !strings.Contains(adjusted.Proposed, `"notlabels"`) {
		t.Fatalf("proposed: %s", adjusted.Proposed)
	}
	updateAndMerge(t, s, UpdateRequest{Dir: dir, Base: adjusted.Base, Signature: adjusted.Signature, Options: &o})
	p := readPipeline(t, dir)
	if p.Versions == nil || len(p.Versions.NotLabels) != 1 || p.Versions.NotLabels[0] != (molten.PipelineNotLabel{Path: "NOTES.md", Text: "Plugin version: 0.1.0"}) {
		t.Fatalf("notlabels: %+v", p.Versions)
	}
	after, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if after.State != UpdateStateUpToDate || len(after.Reasons) != 0 {
		t.Fatalf("after the merge: %s %+v %s", after.State, after.Reasons, strings.Join(ChangeKeys(after.Changes), ","))
	}
	if _, found := labelByPath(Detect(dir).Labels, "NOTES.md"); found {
		t.Fatal("a dismissed label is found again")
	}
}

// The dismissal holds the line by its text: a line added above it does not bring it back.
func TestDismissalSurvivesMovedLines(t *testing.T) {
	not := []molten.PipelineNotLabel{{Path: "NOTES.md", Text: "Plugin version: 0.1.0"}}
	moved := VersionLabel{Path: "NOTES.md", Line: 9, Text: "Plugin version: 0.1.0"}
	other := VersionLabel{Path: "NOTES.md", Line: 3, Text: "Plugin version: 0.2.0"}
	if !dismissedLabel(not, moved) || dismissedLabel(not, other) {
		t.Fatal("a dismissal names its file and its line's text")
	}
}

func TestNotLabelsMustNameAFileAndAText(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"package.json": `{ "name": "app", "version": "1.2.3" }`})
	text := `{ "schema": 1, "name": "app", "versions": { "files": [{ "path": "package.json", "format": "json", "keys": [["version"]] }],
		"notlabels": [{ "path": "../x.md", "text": "a" }, { "path": "README.md", "text": " " }, { "path": "README.md", "text": "version: 0.1.0" }] } }`
	report := molten.ValidatePipelineData(dir, []byte(text))
	if report.Valid || len(report.Errors) != 2 || !strings.Contains(report.Errors[0], "notlabels[0]") || !strings.Contains(report.Errors[1], "notlabels[1]") {
		t.Fatalf("errors: %v", report.Errors)
	}
}
