// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig/defaultconfig"
)

// #1709: MoltenTerm makes no view on the user's behalf, so the built-in template is empty; Scoping and Control room
// are suggestions of the new-view launcher (FR-SHELL-138).
func TestDefaultNewWorkspaceViews(t *testing.T) {
	barr, err := defaultconfig.ConfigFS.ReadFile("settings.json")
	if err != nil {
		t.Fatalf("read default settings: %v", err)
	}
	var settings SettingsType
	if err := json.Unmarshal(barr, &settings); err != nil {
		t.Fatalf("parse default settings: %v", err)
	}
	if views := settings.AppNewWorkspaceViews; len(views) != 0 {
		t.Fatalf("the built-in template is empty, got %v", views)
	}
}

// #1305: the settings screen writes the template as decoded JSON, a list of objects.
func TestConvertConfigListOfObjects(t *testing.T) {
	ctype := getConfigKeyType("app:newworkspaceviews")
	if ctype == nil || ctype.Kind() != reflect.Slice {
		t.Fatalf("app:newworkspaceviews type %v", ctype)
	}
	if _, ok := convertConfigList([]any{map[string]any{"name": "A", "panels": []any{"agent"}}}, ctype); ok {
		t.Fatalf("the item-by-item conversion does not take objects")
	}
	got, ok := convertConfigMap([]any{map[string]any{"name": "A", "panels": []any{"agent", "files"}}}, ctype)
	if !ok {
		t.Fatalf("a list of objects converts through JSON")
	}
	views := got.([]NewWorkspaceViewType)
	if len(views) != 1 || views[0].Name != "A" || !slices.Equal(views[0].Panels, []string{"agent", "files"}) {
		t.Fatalf("converted %+v", views)
	}
	if _, ok := convertConfigMap([]any{"agent"}, ctype); ok {
		t.Fatalf("a list of strings is not a list of views")
	}
}

// #1421: a template Preferences saved under #1305 still names its second view by the Integration key; it reads as
// Control room (fr: Pilotage), and a name the developer typed stays as typed.
func TestLegacyNewWorkspaceViewsReadAsToday(t *testing.T) {
	configDir := t.TempDir()
	settings := []byte(`{"app:newworkspaceviews": [
		{"namekey": "workspaceViews.names.scoping", "panels": ["agent", "browser", "files"]},
		{"namekey": "workspaceViews.names.integration", "panels": ["project", "integration"]},
		{"name": "Integration", "panels": ["integration"]}
	]}`)
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), settings, 0o644); err != nil {
		t.Fatal(err)
	}
	previous := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = configDir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = previous })

	views := ReadFullConfig().Settings.AppNewWorkspaceViews
	if len(views) != 3 {
		t.Fatalf("views %+v", views)
	}
	if views[0].NameKey != "workspaceViews.names.scoping" {
		t.Fatalf("scoping %+v", views[0])
	}
	if views[1].NameKey != "workspaceViews.names.pilotage" || !slices.Equal(views[1].Panels, []string{"project", "integration"}) {
		t.Fatalf("the legacy Integration view reads as Control room: %+v", views[1])
	}
	if views[2].Name != "Integration" || views[2].NameKey != "" {
		t.Fatalf("a typed name stays: %+v", views[2])
	}
}
