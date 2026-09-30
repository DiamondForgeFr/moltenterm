// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// A user's settings.json cannot turn telemetry on (FR-FORK-003).
func TestUserSettingsCannotEnableTelemetry(t *testing.T) {
	configDir := t.TempDir()
	settings := []byte(`{"telemetry:enabled": true, "term:fontsize": 13}`)
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), settings, 0o644); err != nil {
		t.Fatal(err)
	}
	previous := wavebase.ConfigHome_VarCache
	wavebase.ConfigHome_VarCache = configDir
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = previous })

	fullConfig := ReadFullConfig()
	if fullConfig.Settings.TelemetryEnabled {
		t.Fatalf("telemetry:enabled must be forced off")
	}
	if fullConfig.Settings.TermFontSize != 13 {
		t.Fatalf("other user settings must still apply, got term:fontsize %v", fullConfig.Settings.TermFontSize)
	}
}
