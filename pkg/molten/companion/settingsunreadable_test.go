// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// A settings.json that fails to read falls back to the defaults, which would read as every plan usage source turned off
// and wipe the readings they recorded (#2451): the sources wait for a readable file.
func TestUnreadableSettingsAreNotFollowed(t *testing.T) {
	if settingsUnreadable(wconfig.FullConfigType{}) {
		t.Error("a readable configuration is followed")
	}
	other := wconfig.FullConfigType{ConfigErrors: []wconfig.ConfigError{{File: "widgets.json", Err: "json syntax error"}}}
	if settingsUnreadable(other) {
		t.Error("another file's error leaves the settings followed")
	}
	broken := wconfig.FullConfigType{ConfigErrors: []wconfig.ConfigError{{File: "settings.json", Err: "json syntax error"}}}
	if !settingsUnreadable(broken) {
		t.Error("a broken settings.json is not followed")
	}
	full := wconfig.FullConfigType{ConfigErrors: []wconfig.ConfigError{{File: "/synthetic/config/settings.json", Err: "read"}}}
	if !settingsUnreadable(full) {
		t.Error("a full path is recognised")
	}
}
