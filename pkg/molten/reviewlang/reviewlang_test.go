// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewlang

import (
	"path/filepath"
	"testing"
)

func TestNormalizeAndSame(t *testing.T) {
	for in, want := range map[string]string{"fr-FR": "fr", "fr_FR.UTF-8": "fr", "French": "fr", "français": "fr", " EN ": "en", "": "", "pt-BR": "pt", "klingon": "klingon"} {
		if got := Normalize(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
	if !Same("fr-FR", "French") || Same("fr", "en") || !Same("", "en") {
		t.Error("same")
	}
	if Name("en-GB") != "English" || Name("xx") != "xx" {
		t.Error("name")
	}
}

func TestDetect(t *testing.T) {
	fr := "Cette PR ajoute la page des réglages et les tests qui sont dans le dossier pour que la page soit testée."
	en := "This PR adds the settings page and the tests that are in the folder, so that the page is tested."
	if got := Detect(fr); got != "fr" {
		t.Errorf("fr: %q", got)
	}
	if got := Detect(en); got != "en" {
		t.Errorf("en: %q", got)
	}
	if got := Detect("Fix #12"); got != "" {
		t.Errorf("too short: %q", got)
	}
	// Code says nothing of the language the people write in.
	code := "```go\nfor i := range the.list { if it is not nil { return the.value and this.that } }\n```\n"
	if got := Detect(code + fr); got != "fr" {
		t.Errorf("code counted: %q", got)
	}
	if got := Detect(fr, en); got != "" {
		t.Errorf("mixed: %q", got)
	}
}

func TestResolve(t *testing.T) {
	files := map[string]string{}
	read := func(path string) []byte {
		if v, ok := files[path]; ok {
			return []byte(v)
		}
		return nil
	}
	dir := "/p"
	texts := 0
	in := Inputs{ProjectDir: dir, ReadFile: read, Texts: func() []string { texts++; return nil }}
	if r := Resolve(in); r.Lang != "en" || r.Source != SourceDefault {
		t.Errorf("default %+v", r)
	}
	files[filepath.Join(dir, "README.md")] = "Ce projet est une application pour les équipes qui ont des tests et des pages dans le dossier."
	if r := Resolve(in); r.Lang != "fr" || r.Source != SourceDetected || r.Name != "French" {
		t.Errorf("readme %+v", r)
	}
	in.Setting = "de"
	if r := Resolve(in); r.Lang != "de" || r.Source != SourceSetting {
		t.Errorf("setting %+v", r)
	}
	files[filepath.Join(dir, ".saasfoundry.json")] = `{"language":{"tickets":"en"}}`
	if r := Resolve(in); r.Lang != "en" || r.Source != SourceProject {
		t.Errorf("project %+v", r)
	}
	if texts != 2 {
		t.Errorf("the PRs were read %d times; only without a declared language", texts)
	}
}
