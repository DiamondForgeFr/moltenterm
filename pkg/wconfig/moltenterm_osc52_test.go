// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wconfig

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig/defaultconfig"
)

// #2121: only the focused terminal may write the clipboard through OSC 52 unless the user chooses "always".
func TestDefaultOsc52IsFocus(t *testing.T) {
	barr, err := defaultconfig.ConfigFS.ReadFile("settings.json")
	if err != nil {
		t.Fatalf("read default settings: %v", err)
	}
	var settings SettingsType
	if err := json.Unmarshal(barr, &settings); err != nil {
		t.Fatalf("parse default settings: %v", err)
	}
	if settings.TermOsc52 != "focus" {
		t.Fatalf("term:osc52 defaults to focus, got %q", settings.TermOsc52)
	}
}
