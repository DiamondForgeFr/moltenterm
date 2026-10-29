// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wconfig

import "github.com/wavetermdev/waveterm/pkg/waveobj"

const FirstLaunchTermTheme = "coulee"

// The Coulée theme is the default of a fresh install only (FR-SHELL-117). The built-in default stays Wave's, so an
// install that never chose a theme keeps its look; a first launch writes the choice into the user's settings.json,
// where it is visible and the developer can change it. An existing term:theme is never overwritten.
func SeedFirstLaunchTermTheme() error {
	m, cerrs := ReadWaveHomeConfigFile(SettingsFile)
	if len(cerrs) > 0 {
		return nil
	}
	if _, ok := m[ConfigKey_TermTheme]; ok {
		return nil
	}
	toWrite := waveobj.MetaMapType{ConfigKey_TermTheme: FirstLaunchTermTheme}
	// Wave draws a terminal at 50 % over the window's tint; Coulée's background is the opaque surface-term #100E0C.
	if _, ok := m[ConfigKey_TermTransparency]; !ok {
		toWrite[ConfigKey_TermTransparency] = float64(0)
	}
	return SetBaseConfigValue(toWrite)
}
