// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

func useConfigDir(t *testing.T, settings string) string {
	t.Helper()
	configDir := t.TempDir()
	if settings != "" {
		if err := os.WriteFile(filepath.Join(configDir, "settings.json"), []byte(settings), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	previous := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = configDir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = previous })
	return configDir
}

func TestSeedFirstLaunchTermThemeWritesCoulee(t *testing.T) {
	useConfigDir(t, `{"term:fontsize": 13}`)
	if err := SeedFirstLaunchTermTheme(); err != nil {
		t.Fatal(err)
	}
	settings := ReadFullConfig().Settings
	if settings.TermTheme != "coulee" || settings.TermFontSize != 13 {
		t.Fatalf("theme %q fontsize %v, want coulee and 13", settings.TermTheme, settings.TermFontSize)
	}
}

func TestSeedFirstLaunchTermThemeKeepsAChosenTheme(t *testing.T) {
	configDir := useConfigDir(t, `{"term:theme": "onedarkpro"}`)
	if err := SeedFirstLaunchTermTheme(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "onedarkpro") || strings.Contains(string(data), "coulee") {
		t.Fatalf("settings.json = %s", data)
	}
}

func TestCouleeThemeIsBuiltIn(t *testing.T) {
	useConfigDir(t, "")
	theme, ok := ReadFullConfig().TermThemes["coulee"]
	if !ok || theme.Background != "#100E0C" || theme.Cursor != "#FF7C0D" || theme.SelectionBackground != "#4A3020" {
		t.Fatalf("coulee theme = %+v (found %v)", theme, ok)
	}
}
