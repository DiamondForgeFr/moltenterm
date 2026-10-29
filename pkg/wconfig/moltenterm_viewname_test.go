// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// #1311: text wavesrv writes itself names a default view never renamed in English, never by its key.
func TestViewNameText(t *testing.T) {
	cases := map[string]string{
		"workspaceViews.names.scoping":     "Scoping",
		"workspaceViews.names.integration": "Integration",
		"workspaceViews.names.view":        "View",
		"workspaceViews.names.later":       "View",
		"Cadrage":                          "Cadrage",
		"T2":                               "T2",
		"":                                 "",
		"workspaceViews.panels.agent":      "workspaceViews.panels.agent",
	}
	for name, want := range cases {
		if got := ViewNameText(name); got != want {
			t.Errorf("ViewNameText(%q) = %q, want %q", name, got, want)
		}
	}
}

// The English matches the windows' reference dictionary, so `molten` and a window name a view alike.
func TestViewNameTextMatchesEnglishLocale(t *testing.T) {
	barr, err := os.ReadFile(filepath.Join("..", "..", "frontend", "moltenterm-shell", "i18n", "locales", "en.json"))
	if err != nil {
		t.Fatalf("read en.json: %v", err)
	}
	var dict struct {
		WorkspaceViews struct {
			Names map[string]string `json:"names"`
		} `json:"workspaceViews"`
	}
	if err := json.Unmarshal(barr, &dict); err != nil {
		t.Fatalf("parse en.json: %v", err)
	}
	if len(dict.WorkspaceViews.Names) != len(viewNamesEnglish) {
		t.Fatalf("en.json has %d view names, ViewNameText %d", len(dict.WorkspaceViews.Names), len(viewNamesEnglish))
	}
	for id, english := range dict.WorkspaceViews.Names {
		key := ViewNameKeyPrefix + id
		if got := viewNamesEnglish[key]; got != english {
			t.Errorf("%s: en.json %q, ViewNameText %q", key, english, got)
		}
	}
	if !strings.HasPrefix(DefaultViewNameKey, ViewNameKeyPrefix) {
		t.Fatalf("the default key %q is outside the prefix", DefaultViewNameKey)
	}
}
