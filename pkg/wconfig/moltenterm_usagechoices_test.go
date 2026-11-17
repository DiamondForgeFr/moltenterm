// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wconfig

import (
	"slices"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// #2341: the providers Brokk's usage grid always shows or never shows are lists of agent ids in MoltenTerm's own
// settings, written by the window as decoded JSON and read back after a restart.
func TestUsageGridChoicesAreKeptInTheSettings(t *testing.T) {
	useConfigDir(t, `{"term:fontsize": 13}`)
	if err := SetBaseConfigValue(waveobj.MetaMapType{
		"boss:usageshow": []any{"codex"},
		"boss:usagehide": []any{"claude", "other"},
	}); err != nil {
		t.Fatalf("set: %v", err)
	}
	settings := ReadFullConfig().Settings
	if !slices.Equal(settings.BossUsageShow, []string{"codex"}) || !slices.Equal(settings.BossUsageHide, []string{"claude", "other"}) {
		t.Fatalf("show %v, hide %v after a restart", settings.BossUsageShow, settings.BossUsageHide)
	}
	if settings.TermFontSize != 13 {
		t.Fatalf("the other settings were lost: font size %v", settings.TermFontSize)
	}
}

// A choice given back to the rules is a key taken away, so a settings file with no choice holds none.
func TestUsageGridChoicesAreTakenAwayWithNull(t *testing.T) {
	configDir := useConfigDir(t, `{"boss:usageshow": ["codex"], "boss:usagehide": ["claude"]}`)
	if err := SetBaseConfigValue(waveobj.MetaMapType{"boss:usageshow": nil, "boss:usagehide": []any{"claude"}}); err != nil {
		t.Fatalf("set: %v", err)
	}
	m, cerrs := ReadWaveHomeConfigFile(SettingsFile)
	if len(cerrs) > 0 {
		t.Fatalf("read %s: %v", configDir, cerrs[0])
	}
	if _, found := m["boss:usageshow"]; found {
		t.Fatalf("boss:usageshow is still in the file: %v", m)
	}
	if got := ReadFullConfig().Settings; len(got.BossUsageShow) != 0 || !slices.Equal(got.BossUsageHide, []string{"claude"}) {
		t.Fatalf("show %v, hide %v", got.BossUsageShow, got.BossUsageHide)
	}
}

// Anything but a list of strings is refused rather than stored.
func TestUsageGridChoicesRefuseWhatIsNotAList(t *testing.T) {
	useConfigDir(t, "")
	if err := SetBaseConfigValue(waveobj.MetaMapType{"boss:usagehide": "claude"}); err == nil {
		t.Fatalf("a string was accepted for a list of agents")
	}
	if err := SetBaseConfigValue(waveobj.MetaMapType{"boss:usageshow": []any{1, 2}}); err == nil {
		t.Fatalf("a list of numbers was accepted for a list of agents")
	}
}
