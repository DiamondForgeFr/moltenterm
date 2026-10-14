// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMoltenNewLanguagePack(t *testing.T) {
	configDir := t.TempDir()
	dir, file, err := moltenNewLanguagePack(configDir, "lang-es", "", "", "ES", "Español")
	if err != nil {
		t.Fatal(err)
	}
	if file != filepath.Join(dir, "locales", "es.json") {
		t.Fatalf("unexpected dictionary path %s", file)
	}
	data, _ := os.ReadFile(file)
	if string(data) != "{}\n" {
		t.Fatalf("the dictionary starts empty: %q", data)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, MoltenManifestFileName))
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if _, ok := manifest["main"]; ok {
		t.Fatalf("a language pack has no main: %s", raw)
	}
	if _, ok := manifest["capabilities"]; ok {
		t.Fatalf("a language pack declares no capability: %s", raw)
	}
	var parsed MoltenTemplateManifest
	json.Unmarshal(raw, &parsed)
	if !parsed.isDataOnly() || parsed.Languages[0] != (MoltenLanguageEntry{Code: "es", Name: "Español", File: "locales/es.json"}) {
		t.Fatalf("unexpected manifest: %s", raw)
	}
	if parsed.Name != "Español language pack" {
		t.Fatalf("unexpected name %q", parsed.Name)
	}
	if _, _, err := moltenNewLanguagePack(configDir, "lang-es", "", "", "es", ""); err == nil {
		t.Fatal("an existing mod must not be overwritten")
	}
	if _, _, err := moltenNewLanguagePack(configDir, "lang-x", "", "", "spanish", ""); err == nil {
		t.Fatal("a language name is not a code")
	}
}

func TestMoltenTemplateManifestDataOnly(t *testing.T) {
	code := MoltenTemplateManifest{Main: "main.js"}
	pack := MoltenTemplateManifest{Languages: []MoltenLanguageEntry{{Code: "es"}}}
	both := MoltenTemplateManifest{Main: "main.js", Languages: []MoltenLanguageEntry{{Code: "es"}}}
	if code.isDataOnly() || !pack.isDataOnly() || both.isDataOnly() {
		t.Fatal("only a manifest with languages and no main is data-only; with main it goes through trust and is refused there")
	}
}

func TestMoltenLanguageOfFile(t *testing.T) {
	cases := map[string]string{"es.json": "es", "/x/locales/pt-BR.json": "pt-br", "pt_br.json": "pt-br"}
	for path, want := range cases {
		got, err := moltenLanguageOfFile(path, "")
		if err != nil || got != want {
			t.Errorf("%s: got %q, %v; want %q", path, got, err, want)
		}
	}
	if _, err := moltenLanguageOfFile("translation.json", ""); err == nil {
		t.Error("a file name that is no code needs --lang")
	}
	if got, _ := moltenLanguageOfFile("translation.json", "de"); got != "de" {
		t.Errorf("--lang wins, got %q", got)
	}
}

func TestFormatMoltenI18nCheck(t *testing.T) {
	ok := formatMoltenI18nCheck(MoltenI18nCheck{File: "es.json", Code: "es", Ok: true, Translated: 90, Total: 100, Missing: 10,
		Warnings: []MoltenI18nProblem{{Key: "x", Message: `"x" is not an English key: ignored`}}})
	if !strings.Contains(ok, "es.json (es): ok, 90 of 100 strings translated, 10 missing") || !strings.Contains(ok, `warning: "x" is not an English key`) {
		t.Fatalf("unexpected output:\n%s", ok)
	}
	refused := formatMoltenI18nCheck(MoltenI18nCheck{File: "es.json", Code: "es", Errors: []MoltenI18nProblem{{Key: "a.b", Message: `"a.b": placeholder {count} is missing`}}})
	if !strings.Contains(refused, "refused") || !strings.Contains(refused, `error: "a.b": placeholder {count} is missing`) {
		t.Fatalf("unexpected output:\n%s", refused)
	}
}

func TestFormatMoltenI18nStatus(t *testing.T) {
	out := formatMoltenI18nStatus(MoltenI18nStatus{
		Active: "es",
		Languages: []MoltenI18nLanguage{
			{Code: "en", Name: "English", Shipped: true, Total: 100},
			{Code: "fr", Name: "Français", Shipped: true, Pack: "fr-fix", Total: 100},
			{Code: "es", Name: "Español", Pack: "lang-es", Untranslated: 12, Total: 100},
		},
		Shadowed: []MoltenI18nShadowed{{ModId: "old-es", Code: "es", By: "lang-es"}},
		Refused:  []MoltenI18nRefused{{Id: "lang-de", State: "refused", Error: "locales/de.json: bad"}},
	})
	for _, want := range []string{
		"interface language: es",
		"shipped, overrides from pack fr-fix",
		"pack lang-es",
		"12 of 100",
		`pack "old-es" also gives es: "lang-es", enabled more recently, is used`,
		`pack "lang-de" is refused: locales/de.json: bad`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestMoltenEnabledAtKeepsTheLatest(t *testing.T) {
	configDir := t.TempDir()
	first := time.Date(2026, 10, 14, 10, 0, 0, 0, time.UTC)
	moltenSetEnabledAt(configDir, "a", true, first)
	moltenSetEnabledAt(configDir, "b", true, first.Add(time.Minute))
	moltenSetEnabledAt(configDir, "a", false, first.Add(2*time.Minute))
	moltenSetEnabledAt(configDir, "a", true, first.Add(3*time.Minute))
	state, _ := moltenReadState(moltenStateFile(configDir))
	if state.EnabledAt["a"] != "2026-10-14T10:03:00Z" || state.EnabledAt["b"] != "2026-10-14T10:01:00Z" {
		t.Fatalf("unexpected enable times: %+v", state.EnabledAt)
	}
	moltenSetBuiltinEnabled(configDir, "copy-box", false)
	state, _ = moltenReadState(moltenStateFile(configDir))
	if len(state.EnabledAt) != 2 {
		t.Fatalf("other writes keep the enable times: %+v", state.EnabledAt)
	}
}
